import { prisma } from "@tuti/db";

/**
 * Who's in the widget's Messages now (docs/plan.md, Support inbox, "Live"): someone is online while
 * their Messages is open (its live stream checks in every 25 seconds) and for 2 minutes after their
 * last request, which is written at most once a minute, so an open panel costs one write a minute.
 */

export const ONLINE_FOR_MS = 2 * 60_000;
const WRITE_EVERY_MS = 60_000;

/** The key presence is kept under: someone Tuti knows by their user id, a signed-out visitor by their token's hash. */
export const presenceKey = (who: { userId: string | null; visitorHash: string | null }) => who.userId ?? `visitor:${who.visitorHash}`;

/** They're here now (written only if the last write is a minute old). */
export async function touchPresence(projectId: string, key: string, now = new Date()) {
  const stale = new Date(now.getTime() - WRITE_EVERY_MS);
  await prisma.$executeRaw`
    INSERT INTO "widget_presence" ("projectId", "who", "lastSeenAt") VALUES (${projectId}, ${key}, ${now})
    ON CONFLICT ("projectId", "who") DO UPDATE SET "lastSeenAt" = EXCLUDED."lastSeenAt"
    WHERE "widget_presence"."lastSeenAt" < ${stale}`;
}

/** Whether they've been in the widget's Messages in the last 2 minutes. */
export async function isOnline(projectId: string, key: string, now = new Date()) {
  const row = await prisma.widgetPresence.findUnique({ where: { projectId_who: { projectId, who: key } }, select: { lastSeenAt: true } });
  return !!row && now.getTime() - row.lastSeenAt.getTime() < ONLINE_FOR_MS;
}
