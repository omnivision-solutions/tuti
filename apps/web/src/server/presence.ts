import { prisma } from "@tuti/db";

/**
 * Who's in the widget's Messages now (docs/plan.md, Support inbox, "Live"): someone is online while
 * their Messages is on screen (the panel says so every minute; a hidden one doesn't) and for 2 minutes
 * after, written at most once a minute. Coming online tells the team's pages (server/live.ts), and
 * a page showing "Online" refreshes when it runs out.
 */

export const ONLINE_FOR_MS = 2 * 60_000;
const WRITE_EVERY_MS = 60_000;

/** The key presence is kept under: someone Tuti knows by their user id, a signed-out visitor by their token's hash. */
export const presenceKey = (who: { userId: string | null; visitorHash: string | null }) => who.userId ?? `visitor:${who.visitorHash}`;

/** They're here now (written only if the last write is a minute old); returns whether they've just come online. */
export async function touchPresence(projectId: string, key: string, now = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - WRITE_EVERY_MS);
  const before = await prisma.widgetPresence.findUnique({ where: { projectId_who: { projectId, who: key } }, select: { lastSeenAt: true } });
  await prisma.$executeRaw`
    INSERT INTO "widget_presence" ("projectId", "who", "lastSeenAt") VALUES (${projectId}, ${key}, ${now})
    ON CONFLICT ("projectId", "who") DO UPDATE SET "lastSeenAt" = EXCLUDED."lastSeenAt"
    WHERE "widget_presence"."lastSeenAt" < ${stale}`;
  return !before || now.getTime() - before.lastSeenAt.getTime() >= ONLINE_FOR_MS;
}

/** Until when they're online (2 minutes after they were last here), or null when they aren't. */
export async function onlineUntil(projectId: string, key: string, now = new Date()): Promise<Date | null> {
  const row = await prisma.widgetPresence.findUnique({ where: { projectId_who: { projectId, who: key } }, select: { lastSeenAt: true } });
  const until = row && new Date(row.lastSeenAt.getTime() + ONLINE_FOR_MS);
  return until && until > now ? until : null;
}
