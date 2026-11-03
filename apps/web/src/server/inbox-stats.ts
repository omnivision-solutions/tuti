import { prisma } from "@tuti/db";

import { awake } from "@/server/operations/conversations";
import { usualReplyMs } from "@/server/widget-home";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * The Inbox's numbers, beside the list until a conversation opens: how many need a reply (the Needs reply view's) and
 * since when the longest has waited, the widget's usual first reply, and the conversations started in the last 7 days.
 * Spam and sample content left out, as Home's numbers do.
 * Not "closed this week": a close isn't recorded with its time (`updatedAt` moves with any change).
 */
export async function inboxStats(projectId: string, now = new Date()) {
  const needsReply = { projectId, spam: false, sample: false, status: "OPEN" as const, ...awake(now) };
  const [waiting, sinceWaiting, sinceMessage, newThisWeek, replyMs] = await Promise.all([
    prisma.conversation.count({ where: needsReply }),
    // As the Needs reply list: who's waited since their unanswered message, or (set back to Open by hand) since the latest.
    prisma.conversation.aggregate({ where: { ...needsReply, waitingSince: { not: null } }, _min: { waitingSince: true } }),
    prisma.conversation.aggregate({ where: { ...needsReply, waitingSince: null }, _min: { lastMessageAt: true } }),
    prisma.conversation.count({ where: { projectId, spam: false, sample: false, createdAt: { gte: new Date(now.getTime() - WEEK_MS) } } }),
    usualReplyMs(projectId, now),
  ]);
  const oldest = [sinceWaiting._min.waitingSince, sinceMessage._min.lastMessageAt].filter((d) => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return { waiting, oldest, replyMs, newThisWeek };
}
