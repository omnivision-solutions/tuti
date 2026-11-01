import { type Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { author, authorId } from "./create";
import { defineOperation } from "./define";

/**
 * What's new per person (Phase 9): how far someone has read the project's
 * announcements, kept per project and user so that seeing them on one device
 * (the widget's What's new, the portal's /changelog) clears them on the others.
 */

/** Announcements older than this aren't "new" any more (the widget's dot, the portal's marker). */
const FRESH_DAYS = 30;

/** Announced entries published since then may be new to someone. */
export const freshSince = (now = new Date()) => new Date(now.getTime() - FRESH_DAYS * 24 * 60 * 60 * 1000);

/** When the project's latest announced entry from the last FRESH_DAYS was published, if there is one. */
export async function latestAnnouncedAt(project: Prisma.ProjectWhereInput): Promise<Date | null> {
  const entry = await prisma.changelogEntry.findFirst({
    where: { project, announced: true, publishedAt: { not: null, gte: freshSince() } },
    orderBy: { publishedAt: "desc" },
    select: { publishedAt: true },
  });
  return entry?.publishedAt ?? null;
}

/** Up to when this person has seen the project's announcements, on any device. */
export async function changelogSeenAt(projectId: string, userId: string): Promise<Date | null> {
  const row = await prisma.changelogSeen.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { seenAt: true } });
  return row?.seenAt ?? null;
}

/** Whether this person has a fresh announcement they haven't seen anywhere. */
export async function hasUnseenAnnouncement(projectId: string, userId: string): Promise<boolean> {
  const [latest, seen] = await Promise.all([latestAnnouncedAt({ id: projectId }), changelogSeenAt(projectId, userId)]);
  return !!latest && (!seen || latest > seen);
}

export const markChangelogSeen = defineOperation({
  name: "changelog.seen",
  summary:
    "Mark the announced changelog entries published up to `at` (default: now) as seen, as the key's creator or on behalf of someone from your app; it never moves back",
  method: "POST",
  path: "/changelog/seen",
  scope: "write",
  access: "anyone",
  input: z.object({ at: z.iso.datetime({ offset: true }).optional(), author }),
  example: { at: "2026-10-20T09:00:00Z", author: { id: "user-42" } },
  run: async (context, input) => {
    const userId = await authorId(context, input.author);
    const now = new Date();
    // Not later than now: a time from the future would hide announcements still to come.
    const at = input.at && new Date(input.at) < now ? new Date(input.at) : now;
    const key = { projectId: context.projectId, userId };
    // Two statements that each only ever move it forward, so concurrent calls (two devices) end on the later time.
    await prisma.changelogSeen.createMany({ data: { ...key, seenAt: at }, skipDuplicates: true });
    await prisma.changelogSeen.updateMany({ where: { ...key, seenAt: { lt: at } }, data: { seenAt: at } });
    return { seenAt: (await changelogSeenAt(context.projectId, userId))!.toISOString() };
  },
});
