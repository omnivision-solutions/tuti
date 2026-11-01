import { type PostStatus, prisma } from "@tuti/db";

import { postPath } from "@/lib/post-urls";

import { docsContents, popularArticles } from "./docs-queries";
import { canReadPortal } from "./portal-access";
import { ROADMAP } from "./operations/read";

/**
 * What the widget's Home shows besides links: when the team usually replies, a few of its faces,
 * and the news of someone's ideas. Not a "use server" module: never callable from browsers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Home's suggested articles: the three most read lately that whoever's here may open (the docs home's Popular articles). */
export async function suggestedArticles(projectSlug: string) {
  return popularArticles(projectSlug, await docsContents(projectSlug), 3);
}

/** Over how many days first replies count, how many it takes to say anything, and how long a project's answer is kept. */
const REPLY_DAYS = 30;
const MIN_REPLIES = 5;
const REPLY_CACHE_MS = 5 * 60 * 1000;

// ponytail: kept in each server process's memory (one number per project); share it (a stored value a job refreshes) if the processes multiply.
const replyCache = new Map<string, { until: number; ms: number | null }>();

/**
 * How long the team usually takes to answer, in milliseconds: the median, over conversations started
 * in the last 30 days (spam left out), of the time from the user's first message to the team's first
 * reply after it (notes aren't replies; nor is the AI). Null with fewer than five answered. Every
 * widget's Home asks, and the answer changes slowly: worked out once every five minutes per project.
 */
// ponytail: unanswered conversations don't count, so a team that leaves many unanswered looks quicker than it is; count them as open-ended if that matters.
export async function usualReplyMs(projectId: string, now = new Date()): Promise<number | null> {
  const cached = replyCache.get(projectId);
  if (cached && now.getTime() < cached.until) {
    return cached.ms;
  }
  const ms = await medianFirstReplyMs(projectId, now);
  replyCache.set(projectId, { until: now.getTime() + REPLY_CACHE_MS, ms });
  return ms;
}

// Conversations by project_id (with spam, its index's start); each one's messages by conversation and time, its index.
async function medianFirstReplyMs(projectId: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - REPLY_DAYS * DAY_MS);
  const [row] = await prisma.$queryRaw<{ median: number | null; replies: bigint }[]>`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM replied - asked)) AS median, COUNT(*) AS replies
    FROM (
      SELECT asked.at AS asked,
        (SELECT MIN(m."createdAt") FROM conversation_message m
          WHERE m."conversationId" = c.id AND m.author = 'TEAM' AND NOT m.note AND m."createdAt" > asked.at) AS replied
      FROM conversation c
      CROSS JOIN LATERAL (SELECT MIN(m."createdAt") AS at FROM conversation_message m WHERE m."conversationId" = c.id AND m.author = 'USER') asked
      WHERE c."projectId" = ${projectId} AND NOT c.spam AND c."createdAt" >= ${since} AND asked.at IS NOT NULL
    ) firsts
    WHERE replied IS NOT NULL`;
  return row && row.median !== null && Number(row.replies) >= MIN_REPLIES ? row.median * 1000 : null;
}

/** Up to three of the team, as faces for "Send us a message": the owners first, then whoever joined first. */
export async function teamFaces(projectId: string) {
  const members = await prisma.teamMember.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { role: true, user: { select: { id: true, name: true, image: true } } },
  });
  // A stable sort: each group stays in the order they joined.
  return members
    .sort((a, b) => Number(b.role === "OWNER") - Number(a.role === "OWNER"))
    .slice(0, 3)
    .map(({ user }) => user);
}

/** How many of someone's ideas' news Home shows, and from how many days back. */
const NEWS = 3;
const NEWS_DAYS = 30;
/** The statuses worth news: the public roadmap's (Planned, In progress, Completed). */
const NEWS_STATUSES: PostStatus[] = ROADMAP.map(({ status }) => status);

export type IdeaNews = { title: string; status: PostStatus; href: string; at: string };

/**
 * The news of someone's ideas: posts they posted or voted on that moved to a roadmap status in the
 * last 30 days and are still there ("Dark mode is now Planned"), newest first, one per post, three at
 * most; none if they may not read the portal.
 */
export async function ideaNews(projectId: string, userId: string, now = new Date()): Promise<IdeaNews[]> {
  if (!(await canReadPortal({ id: projectId }, userId))) {
    return [];
  }
  const since = new Date(now.getTime() - NEWS_DAYS * DAY_MS);
  // Their ideas in a roadmap status that moved lately, each with its latest move: news if that move is to where it is now.
  const posts = await prisma.post.findMany({
    where: {
      projectId,
      duplicateOfId: null,
      status: { in: NEWS_STATUSES },
      OR: [{ authorId: userId }, { votes: { some: { userId } } }],
      events: { some: { createdAt: { gte: since } } },
    },
    select: {
      title: true,
      number: true,
      status: true,
      board: { select: { slug: true } },
      events: { orderBy: { createdAt: "desc" }, take: 1, select: { to: true, createdAt: true } },
    },
  });
  return posts
    .flatMap((post) => {
      const latest = post.events[0];
      return latest && latest.to === post.status && latest.createdAt >= since ? [{ post, at: latest.createdAt }] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, NEWS)
    .map(({ post, at }) => ({ title: post.title, status: post.status, href: postPath(post), at: at.toISOString() }));
}
