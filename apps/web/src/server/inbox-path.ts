import { type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { inGroup, storedRule } from "@tuti/shared/group-conditions";
import { storedProperties } from "@tuti/shared/user-properties";

import { ACTIONS, storedWorkflow, type WorkflowAction, type WorkflowTrigger } from "@/lib/workflows";

import { notifyInbox } from "./live";
import { announceConversation, announceUserMessage } from "./operations/conversations";

/**
 * The path a user's message takes once it's written (docs/plan.md, Inbox automation, "The path"): the spam filter has
 * answered where the conversation started (server/spam.ts), then the team's workflows for "A conversation starts" (the
 * first message) or "A user replies" (any later one), then the team is told (its email and push, the webhooks). Called
 * wherever a user's message arrives: email, the widget, "Ask a person", the API, and Not spam on what the filter filed.
 * A conversation in Spam runs nothing and tells nobody.
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

/** What each action does to the conversation; whether it changed anything (a workflow that changed nothing leaves no note). */
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
 * The reader groups the conversation's person is in now, by key: their properties against each group's conditions, as
 * the panel beside the conversation works them out (operations/users.ts, viewsOf). Only one of the project's users has
 * properties: a signed-out visitor, an address that isn't a user's and a portal account are in no group.
 */
async function groupsOf(tx: Prisma.TransactionClient, projectId: string, userId: string | null) {
  const identity = userId ? await tx.ssoIdentity.findFirst({ where: { userId, projectId }, select: { properties: true } }) : null;
  if (!identity) {
    return new Set<string>();
  }
  const properties = storedProperties(identity.properties);
  const groups = await tx.readerGroup.findMany({ where: { projectId }, select: { key: true, conditions: true, match: true } });
  return new Set(groups.filter((group) => inGroup(storedRule(group), properties)).map((group) => group.key));
}

/**
 * Runs a trigger's list for a user's message: once, top to bottom, the workflows that are on and whose conditions the
 * conversation's person matches now. A marking action lets the next workflow run; a deciding one ends the list. Each
 * workflow that changed something leaves a Tuti note saying so, which is its history. Nothing here starts another
 * workflow: only a user's message does.
 *
 * One transaction, holding the conversation: what the workflows changed, their notes and the fact that they ran for
 * this message (`workflowsRanAt`) are written together, so running it again changes nothing and writes no second note,
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
      const workflows = await tx.workflow.findMany({
        where: { projectId, trigger, enabled: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { name: true, trigger: true, conditions: true, actions: true },
      });
      const held: Held = { id: conversationId, priority: conversation.priority };
      // Asked once, and only when a workflow is for a group.
      let groups: Set<string> | undefined;
      const notes: string[] = [];
      for (const workflow of workflows) {
        const stored = storedWorkflow(workflow);
        if (!stored) {
          continue;
        }
        let matches = true;
        for (const condition of stored.conditions) {
          groups ??= await groupsOf(tx, projectId, conversation.userId);
          matches &&= groups.has(condition.group);
        }
        if (!matches) {
          continue;
        }
        const did: string[] = [];
        for (const action of stored.actions) {
          if (await RUN[action.kind](tx, held, action)) {
            did.push(ACTIONS[action.kind].did);
          }
        }
        if (did.length > 0) {
          notes.push(`${workflow.name} ${new Intl.ListFormat("en-GB").format(did)}`);
        }
        if (stored.actions.some((action) => ACTIONS[action.kind].deciding)) {
          break;
        }
      }
      if (notes.length > 0) {
        // After the conversation's latest message, a millisecond apart, so they read in order (as addMessage times them).
        const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
          SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
        const at = Math.max(Date.now(), latest ? latest.getTime() + 1 : 0);
        await tx.conversationMessage.createMany({
          data: notes.map((body, i) => ({ projectId, conversationId, author: "TUTI" as const, channel: "APP" as const, body, note: true, createdAt: new Date(at + i) })),
        });
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
