import { type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { inGroup, storedRule } from "@tuti/shared/group-conditions";
import { storedProperties } from "@tuti/shared/user-properties";

import { ACTIONS, storedWorkflow, type WorkflowAction, type WorkflowTrigger } from "@/lib/workflows";

import { logEvents } from "./conversation-events";
import { emitEvent } from "./events";
import { notifyInbox } from "./live";
import { announceConversation, announceUserMessage, conversationSelect, messageSelect, messageView } from "./operations/conversations";
import { type SpamJudgement, spamChecksAfter } from "./spam-models";

/**
 * The path a user's message takes once it's written (docs/plan.md, Inbox automation, "The path"): the spam filter has
 * answered where the conversation started (server/spam.ts), then the team's workflows for "A conversation starts" (the
 * first message) or "A user replies" (any later one), then the team is told (its email and push, the webhooks). Called
 * wherever a user's message arrives: email, the widget, "Ask a person", the API, and Not spam on what the filter filed.
 * A conversation in Spam runs nothing and tells nobody. One the free checks left to the models is held (`spamHeldAt`, as
 * spam) while they check it once the request has answered (server/spam-models.ts); settleHold files or releases it.
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
    if (started.spamHeldAt) {
      // Held for the spam filter's models: they're asked once the request has answered, and nothing runs or is told
      // till their verdict releases it (settleHold).
      spamChecksAfter(started.id);
    }
    const changed = started.spam ? {} : await runWorkflows(projectId, started.id, message.id, "conversation_started");
    // Told as the workflows left it (marked priority).
    return announceConversation(projectId, { ...started, ...changed }, message);
  }
  const { conversation, message } = arrival;
  if (!message.inSpam) {
    await runWorkflows(projectId, conversation.id, message.id, "user_replied");
  }
  return announceUserMessage(projectId, conversation.number, message);
}

/** The conversation a list runs on, as it is while the list holds it: an action reads and changes it here too, for the next. */
type Held = { id: string; priority: boolean };

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
    return await prisma.$transaction((tx) => workflowsIn(tx, projectId, conversationId, messageId, trigger));
  } catch (error) {
    log.error("Running a conversation's workflows failed", { projectId, conversationId, messageId, trigger, error });
    return {};
  }
}

/** runWorkflows in a transaction that holds the conversation, or will: the release's (settleHold). Throws. */
async function workflowsIn(tx: Prisma.TransactionClient, projectId: string, conversationId: string, messageId: string, trigger: WorkflowTrigger): Promise<{ priority?: boolean }> {
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
  const workflows = await tx.workflow.findMany({
    where: { projectId, trigger, enabled: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { name: true, trigger: true, conditions: true, actions: true },
  });
  const held: Held = { id: conversationId, priority: conversation.priority };
  // Asked once, and only when a workflow is for a group.
  let groups: Awaited<ReturnType<typeof groupsOf>> | undefined;
  const checked: { name: string; matched: boolean; notIn?: string; did: string[] }[] = [];
  for (const workflow of workflows) {
    const stored = storedWorkflow(workflow);
    if (!stored) {
      continue;
    }
    let notIn: string | undefined;
    for (const condition of stored.conditions) {
      groups ??= await groupsOf(tx, projectId, conversation.userId);
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
      if (await RUN[action.kind](tx, held, action)) {
        did.push(action.kind);
      }
    }
    checked.push({ name: workflow.name, matched: true, did });
    if (stored.actions.some((action) => ACTIONS[action.kind].deciding)) {
      break;
    }
  }
  // A trigger with no workflow to check (none on, or none this release can read) ran nothing to tell of.
  if (checked.length > 0) {
    await logEvents(tx, conversationId, [{ kind: "workflows_ran", actor: "workflow", details: { trigger, workflows: checked } }]);
    await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
  }
  // As it is once this commits, changed here or not: a reply's workflows may have marked it before this ran.
  return { priority: held.priority };
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
      const [held] = await tx.$queryRaw<{ projectId: string; pathDueAt: Date | null; spamHeldAt: Date | null; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]>`
        SELECT "projectId", "pathDueAt", "spamHeldAt", "number", "userId", "visitorHash", "email" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
      if (!held?.pathDueAt) {
        return null;
      }
      // Kept for the models alone (a sign): read, it goes, as it may be another of the sender's addresses.
      await tx.inboundEmail.updateMany({ where: { conversationId, replyTo: { not: null } }, data: { replyTo: null } });
      const spam = !!judgement?.spam;
      await tx.conversation.update({
        where: { id: conversationId },
        // Released: how old it is for a plan's history starts now, as a new conversation's does.
        data: { pathDueAt: null, ...(held.spamHeldAt && { spamHeldAt: null, ...(spam ? { spamReason: "model" } : { spam: false, activeAt: new Date() }) }) },
      });
      if (!held.spamHeldAt) {
        // Decided meanwhile (a teammate's mark), or from before the hold: nothing to settle.
        return { projectId: held.projectId, release: null };
      }
      // The verdict in its Activity (W16): which model, never the model's own words, which a sender could steer.
      const by = judgement && { by: "decision" as const, probability: judgement.probability };
      await logEvents(tx, conversationId, [{ kind: "spam_filter", actor: "spam_filter", details: { spam, reason: spam ? "model" : null, check: judgement ? "model" : "model_unanswered", ...by } }]);
      await notifyInbox(tx, { projectId: held.projectId, conversationId, number: held.number, userId: held.userId, visitorHash: held.visitorHash, email: held.email });
      if (spam) {
        return { projectId: held.projectId, release: null };
      }
      // ponytail: the first 100, as Not spam tells.
      const [first, ...during] = await tx.conversationMessage.findMany({
        where: { conversationId, author: "USER", note: false },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
        select: messageSelect,
      });
      if (first && workflows) {
        await workflowsIn(tx, held.projectId, conversationId, first.id, "conversation_started");
      }
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: conversationSelect });
      return { projectId: held.projectId, release: first ? { conversation, first, during } : null };
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
    const { conversation, first, during } = settled.release;
    try {
      await announceConversation(projectId, conversation, first);
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
