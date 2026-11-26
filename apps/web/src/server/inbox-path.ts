import { type Prisma, prisma } from "@tuti/db";
import { emitEvent } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { inGroup, storedRule } from "@tuti/shared/group-conditions";
import { storedProperties } from "@tuti/shared/user-properties";

import { ACTIONS, AUTOMATED_REPLIES_PER_HOUR, type HandoverReason, storedWorkflow, type WorkflowAction, type WorkflowTrigger } from "@/lib/workflows";

import { logEvents } from "./conversation-events";
import { notifyInbox } from "./live";
import { announceConversation, announceUserMessage } from "./operations/conversations";
import { spamChecksAfter, spamModelsOn } from "./spam-models";

/**
 * The path a user's message takes once it's written (docs/plan.md, Inbox automation, "The path"): the spam filter has
 * answered where the conversation started (server/spam.ts), then the team's workflows for "A conversation starts" (the
 * first message) or "A user replies" (any later one), then, as the AI answers nothing yet, it's about to go to a person
 * (handOver: "the AI is off", or "the user asked" for "Ask a person"), and unless a workflow keeps it with the AI the team
 * is told (its email and push, the webhooks). Called
 * wherever a user's message arrives: email, the widget, "Ask a person", the API, and Not spam on what the filter filed.
 * A conversation in Spam runs nothing and tells nobody. The spam filter's model checks run once the request has answered
 * (server/spam-models.ts), watching only for now: the conversation goes on as the free checks left it.
 */

/** A conversation a user started, with its first message. */
type Started = { started: Parameters<typeof announceConversation>[1]; message: Parameters<typeof announceConversation>[2] };
/** A later message from the user, as addMessage wrote it. */
type Replied = { conversation: { id: string; number: number }; message: Parameters<typeof announceUserMessage>[2] };

export function inboxPath(projectId: string, arrival: Started): ReturnType<typeof announceConversation>;
export function inboxPath(projectId: string, arrival: Replied): ReturnType<typeof announceUserMessage>;
export async function inboxPath(projectId: string, arrival: Started | Replied) {
  if ("started" in arrival) {
    const { started, message } = arrival;
    if (started.spam) {
      return announceConversation(projectId, started, message);
    }
    const changed = await runWorkflows(projectId, started.id, message.id, "conversation_started");
    if (spamModelsOn()) {
      // The spam filter's model checks, watching only: they write a note, once the request has answered, where the
      // free checks left it undecided (`pathDueAt`).
      spamChecksAfter(started.id);
    }
    // Every new conversation starts with the AI, which answers nothing yet: "Ask a person" because the user asked, the
    // rest because it's off.
    const handed = await handOver(projectId, started.id, message.id, started.origin === "ESCALATION" ? "user_asked" : "ai_off");
    // Told as the workflows left it (marked priority, kept with the AI). The team's email and push skip one the AI has.
    const told = await announceConversation(projectId, { ...started, ...changed, ...handed.changed }, message);
    await handedOverEvent(projectId, started.number, handed);
    return told;
  }
  const { conversation, message } = arrival;
  if (message.inSpam) {
    return announceUserMessage(projectId, conversation.number, message);
  }
  await runWorkflows(projectId, conversation.id, message.id, "user_replied");
  // With the AI, which answers nothing yet: about to go to a person again, as it's off.
  const handed = await handOver(projectId, conversation.id, message.id, "ai_off", { onlyFromAi: true });
  const told = await announceUserMessage(projectId, conversation.number, message);
  await handedOverEvent(projectId, conversation.number, handed);
  return told;
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
type Held = { id: string; priority: boolean; capped?: boolean; replied?: boolean; reply?: string; keep?: boolean };

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
export async function runWorkflows(projectId: string, conversationId: string, messageId: string, trigger: WorkflowTrigger): Promise<{ priority?: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
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
      return { priority: held.priority };
    });
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
 * "About to go to a person" (docs/plan.md, Inbox automation, W11): the conversation would go to the team for `reason`, for
 * the user's message `messageId`. The trigger's workflows run (Reply with set text, Don't hand over), then unless one
 * kept it with the AI it's the team's, with a row in its Activity saying why. Past AUTOMATED_REPLIES_PER_HOUR (the AI's
 * replies and the set ones together) the reason is "too many automated replies", and nothing replies or keeps it: it goes
 * to the team. `onlyFromAi`: only while the AI has it (a user's later message; one the team has stays the team's).
 *
 * One transaction holding the conversation, as runWorkflows: the workflows' changes, the set reply, its owner, the
 * Activity rows and the fact that it ran for this message (`handedOverAt`), so running it again does nothing. The caller
 * tells the team (whose email and push skip one the AI has) and the webhooks. Never throws: a handover that fails leaves
 * the conversation as it was, which for a new one is the team's, so it's never left with nobody told.
 */
export async function handOver(projectId: string, conversationId: string, messageId: string, reason: HandoverReason, { onlyFromAi = false } = {}): Promise<Handed> {
  try {
    return await prisma.$transaction(async (tx) => {
      const [conversation] = await tx.$queryRaw<
        { spam: boolean; priority: boolean; handledBy: "AI" | "TEAM"; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]
      >`
        SELECT "spam", "priority", "handledBy", "number", "userId", "visitorHash", "email" FROM "conversation"
        WHERE "id" = ${conversationId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
      if (!conversation || conversation.spam || (onlyFromAi && conversation.handledBy !== "AI")) {
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
      const why: HandoverReason = capped ? "too_many_replies" : reason;
      const held: Held = { id: conversationId, priority: conversation.priority, capped, replied: replied > 0 };
      const checked = await runList(tx, projectId, conversation.userId, "about_to_hand_over", held);
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
      const handledBy = held.keep ? "AI" : "TEAM";
      if (handledBy !== conversation.handledBy || held.priority !== conversation.priority) {
        await tx.conversation.update({ where: { id: conversationId }, data: { handledBy, priority: held.priority } });
      }
      await logEvents(tx, conversationId, [
        ...(checked.length > 0 ? [{ kind: "workflows_ran" as const, actor: "workflow" as const, details: { trigger: "about_to_hand_over", reason: why, workflows: checked } }] : []),
        ...(held.keep ? [] : [{ kind: "handed_over" as const, actor: "tuti" as const, details: { reason: why } }]),
      ]);
      await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
      return { handedOver: held.keep ? null : why, changed: { priority: held.priority, handledBy } };
    });
  } catch (error) {
    log.error("Handing a conversation over failed", { projectId, conversationId, messageId, reason, error });
    return { handedOver: null, changed: {} };
  }
}
