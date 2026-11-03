import { Prisma, prisma } from "@tuti/db";
import { historyDays, type JobInput, longestHistoryDays, plansEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

import type { JobLogger, JobResult } from "./index";

/**
 * How far back a project sees its inbox and AI conversations (docs/plan.md, Plans): its plan's history (historyDays).
 * Older ones are hidden, not deleted: an upgrade shows them again, until `deleteOldHistory` deletes them past the
 * longest plan's history. Without plans, everything is shown and kept.
 */

const DAY_MS = 86_400_000;
const BATCH = 500;

/** Where the project's history starts on its plan (closed conversations left before it are hidden); null without plans. */
export async function historySince(projectId: string, now = new Date()): Promise<Date | null> {
  if (!plansEnabled()) {
    return null;
  }
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
  return new Date(now.getTime() - historyDays(plan)! * DAY_MS);
}

/**
 * The conversations shown with history from `since` (historySince): every one still going (open, snoozed, waiting on
 * either side), and those closed (or spam) with anything done since then. By `updatedAt`, which a message (it moves
 * `lastMessageAt` too: one shows again), closing it and marking it spam all move: closing a conversation whose last
 * message is old doesn't hide it, nor have it deleted, at once.
 */
export const visibleConversations = (since: Date | null): Prisma.ConversationWhereInput =>
  since ? { OR: [{ status: { not: "CLOSED" }, spam: false }, { updatedAt: { gte: since } }] } : {};

/** visibleConversations, in SQL, for the conversation `c`. */
export const visibleConversationsSql = (since: Date | null) =>
  since ? Prisma.sql`((c.status <> 'CLOSED' AND NOT c.spam) OR c."updatedAt" >= ${since})` : Prisma.sql`true`;

/**
 * Deletes what no plan shows any more: conversations past the longest plan's history (visibleConversations'), with their
 * messages, links to posts and attachments, and AI conversations' questions asked before it. Conversations are claimed
 * and deleted in one statement that re-checks them, so one a message just joined (it holds the row) stays; the files of
 * their attachments are deleted after. ponytail: a file whose delete fails is logged and left behind (nothing points at
 * it); batches of 500 conversations, until none is left. A follow-up asked after the cutoff whose earlier question is
 * gone isn't listed in Reporting (it starts no thread): one asked more than the whole history after the question it follows.
 */
export async function deleteOldHistory(_input: JobInput<"deleteOldHistory">, log: JobLogger): Promise<JobResult> {
  const days = longestHistoryDays();
  if (days === null) {
    return { skipped: true };
  }
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const storage = mediaStorage();
  let conversations = 0;
  let files = 0;
  let failed = 0;
  for (;;) {
    // The statement's snapshot still has the messages and attachments the delete cascades to: their keys come back.
    const [batch] = await prisma.$queryRaw<[{ deleted: number; keys: string[] }]>`
      WITH gone AS (
        DELETE FROM conversation c
        WHERE id IN (
          SELECT id FROM conversation c WHERE NOT ${visibleConversationsSql(cutoff)} LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
        )
        AND NOT ${visibleConversationsSql(cutoff)}
        RETURNING id
      )
      SELECT (SELECT count(*) FROM gone)::int AS deleted,
        ARRAY(SELECT a.key FROM conversation_attachment a JOIN conversation_message m ON m.id = a."messageId" WHERE m."conversationId" IN (SELECT id FROM gone)) AS keys`;
    conversations += batch.deleted;
    // Kept nowhere without media storage: nothing to delete.
    for (const key of storage ? batch.keys : []) {
      try {
        await storage!.delete(key);
        files++;
      } catch (error) {
        failed++;
        log.warn(`couldn't delete ${key}: ${(error as Error).message}`);
      }
    }
    if (batch.deleted < BATCH) {
      break;
    }
  }
  const { count: questions } = await prisma.docsQuestion.deleteMany({ where: { createdAt: { lt: cutoff } } });
  log.info(`deleted ${conversations} conversation(s), ${files} attachment file(s) and ${questions} AI question(s) older than ${days} days; ${failed} file(s) couldn't be deleted`);
  return { conversations, files, failedFiles: failed, questions };
}
