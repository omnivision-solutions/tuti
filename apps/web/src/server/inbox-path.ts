import { type ConversationOrigin, type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { inGroup, storedRule } from "@tuti/shared/group-conditions";
import { storedProperties } from "@tuti/shared/user-properties";

import { ACTIONS, AUTOMATED_REPLIES_PER_HOUR, type HandoverReason, storedWorkflow, type WorkflowAction, type WorkflowTrigger } from "@/lib/workflows";

import { aiAnswersFirst, newestFromUser, toAi } from "./ai-turn";
import { logEvents } from "./conversation-events";
import { emitEvent } from "./events";
import { notifyInbox } from "./live";
import { announceConversation, announceUserMessage, conversationSelect, messageSelect, messageView, tellTeam } from "./operations/conversations";
import { type SpamJudgement, spamChecksAfter } from "./spam-models";

/**
 * The path a user's message takes once it's written (docs/plan.md, Inbox automation, "The path"): the spam filter has
 * answered where the conversation started (server/spam.ts), then the team's workflows for "A conversation starts" (the
 * first message) or "A user replies" (any later one), then whoever has it: the AI's turn (server/ai-turn.ts) where it
 * answers (a new email conversation where "AI answers first" is on for email, or one the AI has), else it's about to go
 * to a person (handOver: "the AI is off", or "the user asked" for "Ask a person"; a workflow's Straight to a person
 * hands it over without the list), and unless a workflow keeps it with the AI the team is told (its email and push, the
 * webhooks). Called
 * wherever a user's message arrives: email, the widget, "Ask a person", the API, and Not spam on what the filter filed.
 * A conversation in Spam runs nothing and tells nobody. One the free checks left to the models is held (`spamHeldAt`, as
 * spam) while they check it once the request has answered (server/spam-models.ts); settleHold files or releases it.
 */

/** A conversation a user started, with its first message. */
type Started = { started: Parameters<typeof announceConversation>[1]; message: Parameters<typeof announceConversation>[2] };
/** A later message from the user, as addMessage wrote it. */
type Replied = { conversation: { id: string; number: number }; message: Parameters<typeof announceUserMessage>[2] };

/**
 * `ownerChosen`: a teammate set who has it in the same act (Not spam with `handledBy`): no handover overrides them, and
 * the conversation is told as they left it (the team's notices only when it's the team's).
 */
type PathOptions = { ownerChosen?: boolean };

export function inboxPath(projectId: string, arrival: Started, options?: PathOptions): ReturnType<typeof announceConversation>;
export function inboxPath(projectId: string, arrival: Replied, options?: PathOptions): ReturnType<typeof announceUserMessage>;
export async function inboxPath(projectId: string, arrival: Started | Replied, { ownerChosen = false }: PathOptions = {}) {
  if ("started" in arrival) {
    const { started, message } = arrival;
    if (started.spamHeldAt) {
      // Held for the spam filter's models: they're asked once the request has answered, and nothing runs, is handed over
      // or told till their verdict releases it (settleHold).
      spamChecksAfter(started.id);
    }
    if (started.spam) {
      return announceConversation(projectId, started, message);
    }
    const { straight, ...changed } = await runWorkflows(projectId, started.id, message.id, "conversation_started");
    const handed: Handed = ownerChosen ? { handedOver: null, changed: {} } : await firstOwner(projectId, started, message.id, !!straight);
    // Told as the workflows left it (marked priority, kept with the AI). The team's email and push skip one the AI has.
    const told = await announceConversation(projectId, { ...started, ...changed, ...handed.changed }, message);
    await handedOverEvent(projectId, started.number, handed);
    return told;
  }
  const { conversation, message } = arrival;
  if (message.inSpam) {
    return announceUserMessage(projectId, conversation.number, message);
  }
  const { straight } = await runWorkflows(projectId, conversation.id, message.id, "user_replied");
  // With the AI: its turn where it can answer, else about to go to a person again, as it's off. One the team has stays theirs.
  const handed: Handed = straight
    ? await handOver(projectId, conversation.id, message.id, "straight_to_person", { onlyFromAi: true, skipWorkflows: true })
    : (await toAi(projectId, conversation.id, message.id).catch((error: unknown) => {
          log.error("Giving a reply to the AI failed: it's handed over", { projectId, conversationId: conversation.id, error });
          return false;
        }))
      ? { handedOver: null, changed: {} }
      : await handOver(projectId, conversation.id, message.id, "ai_off", { onlyFromAi: true });
  const told = await announceUserMessage(projectId, conversation.number, message);
  await handedOverEvent(projectId, conversation.number, handed);
  return told;
}

/** Why a new conversation is about to go to a person: "Ask a person" because the user asked, the rest as the AI is off. */
const handoverReason = (conversation: { origin: string }): HandoverReason => (conversation.origin === "ESCALATION" ? "user_asked" : "ai_off");

/**
 * Who has a new conversation once "A conversation starts" has run: the team, straight (a workflow's Straight to a person);
 * the AI, whose turn it is, where it answers first for the conversation's channel and can answer now; else it's about to
 * go to a person ("Ask a person" because the user asked, the rest as the AI is off).
 */
async function firstOwner(projectId: string, conversation: { id: string; origin: ConversationOrigin }, messageId: string, straight: boolean): Promise<Handed> {
  if (straight) {
    return handOver(projectId, conversation.id, messageId, "straight_to_person", { skipWorkflows: true });
  }
  const withAi = await (async () => (await aiAnswersFirst(projectId, conversation.origin)) && (await toAi(projectId, conversation.id, messageId, { start: true })))().catch(
    (error: unknown) => {
      log.error("Giving a new conversation to the AI failed: it's handed over", { projectId, conversationId: conversation.id, error });
      return false;
    },
  );
  return withAi ? { handedOver: null, changed: { handledBy: "AI" } } : handOver(projectId, conversation.id, messageId, handoverReason(conversation));
}

/**
 * handOver for the AI's turn (server/ai-turn.ts), after the user's message was told: then the team (its email and push)
 * and `conversation.handed_over`, where it went to them. Null where a newer message from the user dropped it (`onlyIfLatest`).
 */
export async function handOverAndTell(projectId: string, conversation: { id: string; number: number }, messageId: string, reason: HandoverReason, options: HandOverOptions): Promise<Handed | null> {
  const handed = await handOver(projectId, conversation.id, messageId, reason, options);
  if (handed?.handedOver) {
    await tellTeam(projectId, messageId);
    await handedOverEvent(projectId, conversation.number, handed);
  }
  return handed;
}

/** `conversation.handed_over`, once the conversation's own news (`conversation.created`, the message) has gone. */
async function handedOverEvent(projectId: string, number: number, handed: Handed) {
  if (handed.handedOver) {
    await emitEvent(projectId, "conversation.handed_over", { conversation: number, reason: handed.handedOver });
  }
}

/**
 * The conversation a list runs on, as it is while the list holds it: an action reads and changes it here too, for the
 * next. For "About to go to a person": `capped`, past the automated replies' cap (nothing replies or keeps it then);
 * `replied`, it has had its set reply (once per conversation); `reply`, the set reply this run sends; `keep`, kept with the AI.
 */
type Held = { id: string; priority: boolean; capped?: boolean; replied?: boolean; reply?: string; keep?: boolean; straight?: boolean };

/** What each action does to the conversation; whether it changed anything (the run's Activity row says what did). */
const RUN: { [Kind in WorkflowAction["kind"]]: (tx: Prisma.TransactionClient, held: Held, action: Extract<WorkflowAction, { kind: Kind }>) => Promise<boolean> } = {
  mark_priority: async (tx, held) => {
    if (held.priority) {
      return false;
    }
    await tx.conversation.update({ where: { id: held.id }, data: { priority: true } });
    held.priority = true;
    return true;
  },
  // The first workflow that replies, and only once per conversation: written once the list has run.
  reply_text: async (_tx, held, action) => {
    if (held.capped || held.replied) {
      return false;
    }
    held.reply = action.text;
    held.replied = true;
    return true;
  },
  // Handed over by the caller, once the list has run (handOver, without the AI or "About to go to a person").
  straight_to_person: async (_tx, held) => {
    held.straight = true;
    return true;
  },
  dont_hand_over: async (_tx, held) => {
    if (held.capped) {
      return false;
    }
    held.keep = true;
    return true;
  },
};

/**
 * The project's reader groups by key, with their names and whether the conversation's person is in each now: their
 * properties against each group's conditions, as the panel beside the conversation works them out (operations/users.ts,
 * viewsOf). Only one of the project's users has properties: a signed-out visitor, an address that isn't a user's and a
 * portal account are in no group.
 */
async function groupsOf(tx: Prisma.TransactionClient, projectId: string, userId: string | null) {
  const identity = userId ? await tx.ssoIdentity.findFirst({ where: { userId, projectId }, select: { properties: true } }) : null;
  const properties = identity && storedProperties(identity.properties);
  const groups = await tx.readerGroup.findMany({ where: { projectId }, select: { key: true, name: true, conditions: true, match: true } });
  return new Map(groups.map((group) => [group.key, { name: group.name, in: !!properties && inGroup(storedRule(group), properties) }]));
}

type Checked = { name: string; matched: boolean; notIn?: string; did: string[] }[];

/**
 * A trigger's list, top to bottom, in the transaction that holds the conversation: the workflows that are on and whose
 * conditions its person matches now. A marking action lets the next workflow run; a deciding one ends the list. Returns
 * every workflow it checked, what each did or why it didn't match, for the run's Activity row.
 */
async function runList(tx: Prisma.TransactionClient, projectId: string, userId: string | null, trigger: WorkflowTrigger, held: Held): Promise<Checked> {
  const workflows = await tx.workflow.findMany({
    where: { projectId, trigger, enabled: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { name: true, trigger: true, conditions: true, actions: true },
  });
  // Asked once, and only when a workflow is for a group.
  let groups: Awaited<ReturnType<typeof groupsOf>> | undefined;
  const checked: Checked = [];
  for (const workflow of workflows) {
    const stored = storedWorkflow(workflow);
    if (!stored) {
      continue;
    }
    let notIn: string | undefined;
    for (const condition of stored.conditions) {
      groups ??= await groupsOf(tx, projectId, userId);
      const group = groups.get(condition.group);
      if (!group?.in) {
        notIn ??= group?.name ?? condition.group;
      }
    }
    if (notIn !== undefined) {
      checked.push({ name: workflow.name, matched: false, notIn, did: [] });
      continue;
    }
    const did: string[] = [];
    for (const action of stored.actions) {
      if (await RUN[action.kind](tx, held, action as never)) {
        did.push(action.kind);
      }
    }
    checked.push({ name: workflow.name, matched: true, did });
    if (stored.actions.some((action) => ACTIONS[action.kind].deciding)) {
      break;
    }
  }
  return checked;
}

/**
 * Runs a trigger's list for a user's message: once, top to bottom, the workflows that are on and whose conditions the
 * conversation's person matches now. A marking action lets the next workflow run; a deciding one ends the list. The run
 * is one row of the conversation's Activity (W16): every workflow it checked, what it did or why it didn't match, a run
 * that matched nothing too. Nothing here starts another workflow: only a user's message does.
 *
 * One transaction, holding the conversation: what the workflows changed, the Activity row and the fact that they ran for
 * this message (`workflowsRanAt`) are written together, so running it again changes nothing and writes no second row,
 * whatever the team changed in its workflows meanwhile. A conversation in Spam runs nothing, and its message isn't
 * marked: Not spam on what the filter filed runs its first message's list then.
 *
 * Returns the conversation's priority as it is now, for whoever tells of it. Never throws: the message is in, and the team is
 * told of it whatever happens here. ponytail: a run that failed isn't tried again; `pathDueAt` (W3) is where it would be.
 */
export async function runWorkflows(projectId: string, conversationId: string, messageId: string, trigger: WorkflowTrigger): Promise<Ran> {
  try {
    return await prisma.$transaction((tx) => workflowsIn(tx, projectId, conversationId, messageId, trigger));
  } catch (error) {
    log.error("Running a conversation's workflows failed", { projectId, conversationId, messageId, trigger, error });
    return {};
  }
}

/**
 * What a handover did: `handedOver`, why, where it went to the team (null where a workflow kept it with the AI, it was the
 * team's already, or nothing ran); `changed`, the conversation's fields as it left them, for whoever tells of it.
 */
type Handed = { handedOver: HandoverReason | null; changed: { priority?: boolean; handledBy?: "AI" | "TEAM" } };

/**
 * `onlyFromAi`: only while the AI has it. `skipWorkflows`: no list (Straight to a person). `onlyIfLatest`: nothing (null)
 * where a newer message from the user has come since `messageId`, whose own turn hands over or answers all of it (the
 * AI's turn). `note`: for the team, where it goes to them (the AI's summary).
 */
type HandOverOptions = { onlyFromAi?: boolean; skipWorkflows?: boolean; onlyIfLatest?: boolean; note?: string | null };

/**
 * "About to go to a person" (docs/plan.md, Inbox automation, W11): the conversation would go to the team for `reason`, for
 * the user's message `messageId`. The trigger's workflows run (Reply with set text, Don't hand over), then unless one
 * kept it with the AI it's the team's, with a row in its Activity saying why. Past AUTOMATED_REPLIES_PER_HOUR (the AI's
 * replies and the set ones together) the reason is "too many automated replies", and nothing replies or keeps it: it goes
 * to the team. `onlyFromAi`: only while the AI has it (a user's later message; one the team has stays the team's).
 *
 * One transaction holding the conversation, as runWorkflows: the workflows' changes, the set reply, its owner, the
 * Activity rows and the fact that it ran for this message (`handedOverAt`), so running it again does nothing. The caller
 * tells the team (whose email and push skip one the AI has) and the webhooks. Never throws: a handover that fails gives
 * the conversation to the team (a new one is the team's already), so it's never left with nobody told.
 */
export function handOver(projectId: string, conversationId: string, messageId: string, reason: HandoverReason, options: HandOverOptions & { onlyIfLatest: true }): Promise<Handed | null>;
export function handOver(projectId: string, conversationId: string, messageId: string, reason: HandoverReason, options?: HandOverOptions): Promise<Handed>;
export async function handOver(
  projectId: string,
  conversationId: string,
  messageId: string,
  reason: HandoverReason,
  { onlyFromAi = false, skipWorkflows = false, onlyIfLatest = false, note = null }: HandOverOptions = {},
): Promise<Handed | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const [conversation] = await tx.$queryRaw<
        {
          spam: boolean;
          spamHeldAt: Date | null;
          pathDueAt: Date | null;
          priority: boolean;
          handledBy: "AI" | "TEAM";
          number: number;
          userId: string | null;
          visitorHash: string | null;
          email: string | null;
        }[]
      >`
        SELECT "spam", "spamHeldAt", "pathDueAt", "priority", "handledBy", "number", "userId", "visitorHash", "email" FROM "conversation"
        WHERE "id" = ${conversationId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
      if (!conversation) {
        return { handedOver: null, changed: {} };
      }
      if (onlyIfLatest && (await newestFromUser(tx, conversationId))?.id !== messageId) {
        return null;
      }
      // The AI's turn, if one was due, is settled by this handover (the spam filter's hold keeps its own).
      if (conversation.pathDueAt && !conversation.spamHeldAt) {
        await tx.conversation.update({ where: { id: conversationId }, data: { pathDueAt: null } });
      }
      if (conversation.spam || (onlyFromAi && conversation.handledBy !== "AI")) {
        return { handedOver: null, changed: {} };
      }
      const now = new Date();
      const { count } = await tx.conversationMessage.updateMany({
        where: { id: messageId, conversationId, author: "USER", note: false, handedOverAt: null },
        data: { handedOverAt: now },
      });
      if (count === 0) {
        return { handedOver: null, changed: { priority: conversation.priority, handledBy: conversation.handledBy } };
      }
      const [automated, replied] = await Promise.all([
        tx.conversationMessage.count({ where: { conversationId, author: "AI", note: false, createdAt: { gt: new Date(now.getTime() - 60 * 60_000) } } }),
        // The set reply carries its conversation as its requestId: once per conversation.
        tx.conversationMessage.count({ where: { conversationId, author: "AI", requestId: conversationId } }),
      ]);
      const capped = automated >= AUTOMATED_REPLIES_PER_HOUR;
      const why: HandoverReason = capped && !skipWorkflows ? "too_many_replies" : reason;
      const held: Held = { id: conversationId, priority: conversation.priority, capped, replied: replied > 0 };
      const checked = skipWorkflows ? [] : await runList(tx, projectId, conversation.userId, "about_to_hand_over", held);
      if (held.reply !== undefined) {
        const { channel } = await tx.conversationMessage.findUniqueOrThrow({ where: { id: messageId }, select: { channel: true } });
        // After the conversation's latest, as addMessage times messages. It answers nobody on the team's side: the
        // conversation's status and wait stay as the user's message left them.
        const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
          SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
        const at = new Date(Math.max(Date.now(), latest ? latest.getTime() + 1 : 0));
        await tx.conversationMessage.create({
          data: { projectId, conversationId, author: "AI", authorId: null, channel, body: held.reply, requestId: conversationId, createdAt: at },
        });
        await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at, activeAt: at } });
      }
      if (note && !held.keep) {
        // For the team, after everything in it, as "Ask a person"'s summary is.
        const [{ last }] = await tx.$queryRaw<[{ last: Date | null }]>`
          SELECT MAX("createdAt") AS last FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
        const at = new Date(Math.max(Date.now(), last ? last.getTime() + 1 : 0));
        const { channel } = await tx.conversationMessage.findUniqueOrThrow({ where: { id: messageId }, select: { channel: true } });
        await tx.conversationMessage.create({ data: { projectId, conversationId, author: "AI", authorId: null, channel, body: `Summary: ${note}`, note: true, createdAt: at } });
      }
      const handledBy = held.keep ? "AI" : "TEAM";
      if (handledBy !== conversation.handledBy || held.priority !== conversation.priority) {
        await tx.conversation.update({ where: { id: conversationId }, data: { handledBy, priority: held.priority } });
      }
      await logEvents(tx, conversationId, [
        ...(checked.length > 0 ? [{ kind: "workflows_ran" as const, actor: "workflow" as const, details: { trigger: "about_to_hand_over", reason: why, workflows: checked } }] : []),
        ...(held.keep ? [] : [{ kind: "handed_over" as const, actor: "workflow" as const, details: { reason: why } }]),
      ]);
      // Open pages hear of what they show changing: a workflow's run, a reply, a new owner. A conversation that was the
      // team's and stays so (every new one with no workflows) changed nothing a list shows.
      if (checked.length > 0 || held.reply !== undefined || handledBy !== conversation.handledBy) {
        await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
      }
      return { handedOver: held.keep ? null : why, changed: { priority: held.priority, handledBy } };
    });
  } catch (error) {
    log.error("Handing a conversation over failed", { projectId, conversationId, messageId, reason, error });
    // To the team all the same, so its user's message is never left with nobody told (nothing answers for the AI). In a
    // transaction of its own, under the conversation's lock and claiming the message as the main path does: a retry or a
    // run at once finds it handed over (or kept) already, and changes and tells nothing twice.
    return prisma
      .$transaction(async (tx): Promise<Handed | null> => {
        const [conversation] = await tx.$queryRaw<{ spam: boolean; spamHeldAt: Date | null; handledBy: "AI" | "TEAM" }[]>`
          SELECT "spam", "spamHeldAt", "handledBy" FROM "conversation"
          WHERE "id" = ${conversationId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
        if (!conversation || conversation.spam || (onlyFromAi && conversation.handledBy !== "AI")) {
          return { handedOver: null, changed: {} };
        }
        if (onlyIfLatest && (await newestFromUser(tx, conversationId))?.id !== messageId) {
          return null;
        }
        const { count } = await tx.conversationMessage.updateMany({
          where: { id: messageId, conversationId, author: "USER", note: false, handedOverAt: null },
          data: { handedOverAt: new Date() },
        });
        if (count === 0) {
          // Decided already, by whichever run claimed it: as it left it.
          return { handedOver: null, changed: { handledBy: conversation.handledBy } };
        }
        await tx.conversation.update({ where: { id: conversationId }, data: { handledBy: "TEAM", ...(!conversation.spamHeldAt && { pathDueAt: null }) } });
        await logEvents(tx, conversationId, [{ kind: "handed_over", actor: "workflow", details: { reason } }]);
        return { handedOver: reason, changed: { handledBy: "TEAM" } };
      })
      .catch((fallbackError: unknown): Handed | null => {
        log.error("Handing a conversation over to the team after a failure failed too", { projectId, conversationId, messageId, error: fallbackError });
        // A new conversation is the team's already, and the caller tells the team of it: so are the webhooks.
        return onlyFromAi ? { handedOver: null, changed: {} } : { handedOver: reason, changed: { handledBy: "TEAM" } };
      });
  }
}

/** runWorkflows in a transaction that holds the conversation, or will: the release's (settleHold). Throws. */
/** What a list left for its caller: the conversation's priority as it is now, and whether a workflow sent it straight to a person. */
type Ran = { priority?: boolean; straight?: boolean };

async function workflowsIn(tx: Prisma.TransactionClient, projectId: string, conversationId: string, messageId: string, trigger: WorkflowTrigger): Promise<Ran> {
  const [conversation] = await tx.$queryRaw<{ spam: boolean; priority: boolean; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]>`
    SELECT "spam", "priority", "number", "userId", "visitorHash", "email" FROM "conversation"
    WHERE "id" = ${conversationId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
  if (!conversation || conversation.spam) {
    return {};
  }
  const { count } = await tx.conversationMessage.updateMany({
    where: { id: messageId, conversationId, author: "USER", note: false, workflowsRanAt: null },
    data: { workflowsRanAt: new Date() },
  });
  if (count === 0) {
    // Ran for this message already: the conversation as it is now, whatever ran it.
    return { priority: conversation.priority };
  }
  const held: Held = { id: conversationId, priority: conversation.priority };
  const checked = await runList(tx, projectId, conversation.userId, trigger, held);
  // A trigger with no workflow to check (none on, or none this release can read) ran nothing to tell of.
  if (checked.length > 0) {
    await logEvents(tx, conversationId, [{ kind: "workflows_ran", actor: "workflow", details: { trigger, workflows: checked } }]);
    await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
  }
  // As it is once this commits, changed here or not: a reply's workflows may have marked it before this ran.
  return { priority: held.priority, ...(held.straight && { straight: true }) };
}

/**
 * Settles a held conversation (`spamHeldAt`) with the spam filter's models' verdict, under its lock, once: only while
 * it's still due (`pathDueAt`) and held, so a teammate's mark meanwhile wins and a second run does nothing. Spam is filed
 * with its reason ("model"); anything else (under the band, or no answer: it fails open) is released, with "A
 * conversation starts" for its first message in the same transaction, then told as a new conversation is (its webhook
 * and the team's notices), and what its user wrote during the hold after it, to webhooks, never before it and firing no
 * trigger of its own. A release whose workflows fail is made again without them: the team is told all the same.
 * Returns whether this run settled it.
 */
export async function settleHold(conversationId: string, judgement: SpamJudgement): Promise<boolean> {
  const settle = (workflows: boolean) =>
    prisma.$transaction(async (tx) => {
      const [held] = await tx.$queryRaw<
        {
          projectId: string;
          pathDueAt: Date | null;
          spamHeldAt: Date | null;
          spam: boolean;
          spamMarkedAt: Date | null;
          handledBy: "AI" | "TEAM";
          number: number;
          userId: string | null;
          visitorHash: string | null;
          email: string | null;
        }[]
      >`
        SELECT "projectId", "pathDueAt", "spamHeldAt", "spam", "spamMarkedAt", "handledBy", "number", "userId", "visitorHash", "email" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
      // Not held, with the AI: its `pathDueAt` is the AI's turn (server/ai-turn.ts), nothing of the spam filter's.
      if (held && !held.spamHeldAt && held.handledBy === "AI") {
        return null;
      }
      // Still held, or its checks still due (one from before the hold: W3's). A release from before, running beside this
      // one during a deploy, may clear `pathDueAt` alone: the hold itself is what's settled.
      if (!held || (!held.pathDueAt && (!held.spamHeldAt || (held.spam && held.spamMarkedAt)))) {
        return null;
      }
      // Kept for the models alone (a sign): read, it goes, as it may be another of the sender's addresses.
      await tx.inboundEmail.updateMany({ where: { conversationId, replyTo: { not: null } }, data: { replyTo: null } });
      const spam = !!judgement?.spam;
      // Marked during the hold by a release from before that doesn't know of it (it leaves `spamHeldAt`): Mark as spam
      // has decided, nothing to settle; its Not spam unmarked it but told nobody (it had no reason), so it's released
      // here, as it would have been, without the model's verdict.
      const unmarked = !!held.spamHeldAt && !held.spam;
      // Marked as spam by a teammate (this release or the one before): its `spamHeldAt` stays, for a later Not spam to tell of it.
      const markedSpam = held.spam && !!held.spamMarkedAt;
      const decided = !held.spamHeldAt || markedSpam;
      await tx.conversation.update({
        where: { id: conversationId },
        // Released: how old it is for a plan's history starts now, as a new conversation's does.
        data: { pathDueAt: null, ...(!markedSpam && { spamHeldAt: null }), ...(!decided && !unmarked && (spam ? { spamReason: "model" } : { spam: false, activeAt: new Date() })) },
      });
      if (decided) {
        return { projectId: held.projectId, release: null };
      }
      if (!unmarked) {
        // The verdict in its Activity (W16): how sure the model was, never its own words, which a sender could steer.
        const by = judgement && { by: "decision" as const, probability: judgement.probability };
        await logEvents(tx, conversationId, [{ kind: "spam_filter", actor: "spam_filter", details: { spam, reason: spam ? "model" : null, check: judgement ? "model" : "model_unanswered", ...by } }]);
        await notifyInbox(tx, { projectId: held.projectId, conversationId, number: held.number, userId: held.userId, visitorHash: held.visitorHash, email: held.email });
        if (spam) {
          return { projectId: held.projectId, release: null };
        }
      }
      // ponytail: the first 100, as Not spam tells.
      const [first, ...during] = await tx.conversationMessage.findMany({
        where: { conversationId, author: "USER", note: false },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
        select: messageSelect,
      });
      const ran = first && workflows ? await workflowsIn(tx, held.projectId, conversationId, first.id, "conversation_started") : {};
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: conversationSelect });
      return { projectId: held.projectId, release: first ? { conversation, first, during, straight: !!ran.straight } : null };
    });
  const settled = await settle(true).catch((error: unknown) => {
    log.error("Releasing a held conversation with its workflows failed: released without them", { conversationId, error });
    return settle(false);
  });
  if (!settled) {
    return false;
  }
  if (settled.release) {
    const { projectId } = settled;
    const { conversation, first, during, straight } = settled.release;
    try {
      // Whoever has it, as any new conversation once "A conversation starts" has run: never while held.
      const handed = await firstOwner(projectId, conversation, first.id, straight);
      await announceConversation(projectId, { ...conversation, ...handed.changed }, first);
      await handedOverEvent(projectId, conversation.number, handed);
      for (const message of during) {
        await emitEvent(projectId, "conversation.message_created", { conversation: conversation.number, message: messageView(message) });
      }
    } catch (error) {
      // Released whatever happens here: the team's email is queued again by conversation-notices-resubmit.
      log.error("Announcing a released conversation failed", { projectId, conversationId, error });
    }
  }
  return true;
}
