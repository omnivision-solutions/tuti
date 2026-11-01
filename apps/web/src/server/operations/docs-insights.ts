import { type DocsNoAnswerCause, Prisma, prisma } from "@tuti/db";
import { INSIGHTS_DAYS } from "@tuti/jobs";
import { z } from "zod";

import type { Reader } from "@/lib/read-access";
import { visibleArticleSql } from "@/lib/reader-groups";

import { actorReader } from "../portal-access";
import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";

/**
 * What readers make of the docs (Phase 10): their answers to "Was this helpful?",
 * article views and searches, summed up for the team. Feeds AI answers' gaps (Phase 11)
 * and the docs audit (Phase 12). Stores no IP addresses: see the models in schema.prisma.
 */

export { INSIGHTS_DAYS };
export const MAX_FEEDBACK_COMMENT = 500;

export const answerFields = z.object({
  slug: z.string().trim().min(1).max(80),
  helpful: z.boolean(),
  /** What was missing; only with `helpful: false`. */
  comment: z.string().trim().max(MAX_FEEDBACK_COMMENT, `Up to ${MAX_FEEDBACK_COMMENT} characters`).optional(),
});

/**
 * Saves a reader's answer under a published article whose page is served (not hidden or AI only). One per reader and article: answering
 * again changes it (so a retry or double click counts once). A "No" without a comment keeps
 * the comment the reader already left; a "Yes" drops it.
 */
export async function saveAnswer(projectId: string, readerId: string, input: z.infer<typeof answerFields>, reader: Reader) {
  const comment = input.comment || null;
  if (input.helpful && comment) {
    throw new OperationError(400, "invalid_input", "Only a “No” takes a comment");
  }
  // One statement: the article is checked as the answer is saved.
  const saved = await prisma.$queryRaw<{ helpful: boolean; comment: string | null }[]>`
    INSERT INTO article_feedback ("articleId", "readerId", helpful, comment, "updatedAt")
    SELECT a.id, ${readerId}, ${input.helpful}, ${comment}, now()
    FROM article a
    WHERE a."projectId" = ${projectId} AND a.slug = ${input.slug} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
      AND a.listing IN ('EVERYWHERE', 'UNLISTED') AND ${visibleArticleSql(reader)}
    ON CONFLICT ("articleId", "readerId") DO UPDATE SET
      helpful = EXCLUDED.helpful,
      comment = CASE WHEN EXCLUDED.helpful THEN NULL ELSE coalesce(EXCLUDED.comment, article_feedback.comment) END,
      "updatedAt" = now()
    RETURNING helpful, comment`;
  if (!saved[0]) {
    throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
  }
  return { slug: input.slug, ...saved[0] };
}

export const answerArticle = defineOperation({
  name: "articles.feedback",
  summary:
    "Answer “Was this helpful?” under a published help article (a “No” may say what was missing), as the key's creator or on behalf of someone from your app; answering again replaces the answer",
  method: "POST",
  path: "/articles/{slug}/feedback",
  scope: "write",
  access: "anyone",
  input: answerFields.extend({ author }),
  example: { helpful: false, comment: "It doesn't say how to invite people by email.", author: { id: "user-42" } },
  // Keys act for the team, which reads every article.
  run: async (context, input) => saveAnswer(context.projectId, await authorId(context, input.author), input, await actorReader(context.actor, context.projectId)),
});

/** How the Gaps list groups questions (in SQL, so grouping and dismissing can't disagree): lowercase, trimmed, spaces collapsed. */
const normalized = (text: Prisma.Sql) => Prisma.sql`lower(btrim(regexp_replace(${text}, '[[:space:]]+', ' ', 'g')))`;

/** Where Insights' window starts: whole days (UTC), today included, so daily counts and timestamps cover the same span. */
export function insightsSince(now = new Date()): Date {
  const since = new Date(now.toISOString().slice(0, 10));
  since.setUTCDate(since.getUTCDate() - (INSIGHTS_DAYS - 1));
  return since;
}

/**
 * The searches that found nothing since `since`, one row per query (`firstDay`: the first day it did), without those the team
 * dismissed (docs.dismissGap, matched like Gaps) since last searched. Kept per day: one searched again on the dismissal's day stays hidden.
 */
export const failedSearchesSql = (projectId: string, since: Date) => Prisma.sql`
  SELECT f.query, sum(f.count)::int AS count, min(f.day) AS "firstDay"
  FROM docs_failed_search_day f
  WHERE f."projectId" = ${projectId} AND f.day >= ${since}::date
  GROUP BY f.query
  HAVING NOT EXISTS (
    SELECT 1 FROM docs_gap_dismissal d
    WHERE d."projectId" = ${projectId} AND d.question = ${normalized(Prisma.raw("f.query"))} AND d."dismissedAt"::date >= max(f.day)
  )`;

/** The team's numbers for the last INSIGHTS_DAYS days (docs.insights and the app's insights page). */
export async function docsInsights(projectId: string) {
  const since = insightsSince();
  const [views, articles, comments, searches, topFailed, gaps] = await Promise.all([
    prisma.articleViewDay.aggregate({ where: { article: { projectId, deletedAt: null }, day: { gte: since } }, _sum: { views: true } }),
    prisma.$queryRaw<{ slug: string; title: string; views: number; helpful: number; notHelpful: number }[]>`
      SELECT * FROM (
        SELECT a.slug, a.title,
          (SELECT coalesce(sum(v.views), 0) FROM article_view_day v WHERE v."articleId" = a.id AND v.day >= ${since}::date)::int AS views,
          (SELECT count(*) FROM article_feedback f WHERE f."articleId" = a.id AND f.helpful AND f."updatedAt" >= ${since})::int AS helpful,
          (SELECT count(*) FROM article_feedback f WHERE f."articleId" = a.id AND NOT f.helpful AND f."updatedAt" >= ${since})::int AS "notHelpful"
        FROM article a
        WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL
      ) s
      WHERE views + helpful + "notHelpful" > 0
      ORDER BY views DESC, helpful + "notHelpful" DESC, title
      LIMIT 20`,
    prisma.articleFeedback.findMany({
      where: { article: { projectId, deletedAt: null }, helpful: false, comment: { not: null }, updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { comment: true, updatedAt: true, article: { select: { slug: true, title: true } } },
    }),
    prisma.docsSearchDay.aggregate({ where: { projectId, day: { gte: since } }, _sum: { searches: true, failed: true } }),
    prisma.$queryRaw<{ query: string; count: number }[]>`SELECT query, count FROM (${failedSearchesSql(projectId, since)}) s ORDER BY count DESC, query LIMIT 10`,
    // Gaps: questions the AI couldn't answer or whose answer got a thumbs-down, grouped by
    // normalized question, without what the team dismissed (as asked up to the dismissal).
    // `cause`: why the latest "I don't know" in the group happened; `escalated`: how many were passed to the team ("Ask a person").
    prisma.$queryRaw<
      { question: string; noAnswer: number; notHelpful: number; escalated: number; lastAsked: Date; answer: string | null; cause: string | null }[]
    >`
      SELECT
        (array_agg(q.question ORDER BY q."createdAt" DESC))[1] AS question,
        count(*) FILTER (WHERE q.status = 'NO_ANSWER')::int AS "noAnswer",
        (array_agg(q.cause::text ORDER BY q."createdAt" DESC) FILTER (WHERE q.status = 'NO_ANSWER'))[1] AS cause,
        count(*) FILTER (WHERE q.helpful = false)::int AS "notHelpful",
        count(*) FILTER (WHERE q."escalatedAt" IS NOT NULL)::int AS escalated,
        max(q."createdAt") AS "lastAsked",
        (array_agg(q.answer ORDER BY q."createdAt" DESC) FILTER (WHERE q.helpful = false))[1] AS answer
      FROM (
        SELECT *, ${normalized(Prisma.raw("question"))} AS key FROM docs_question
        WHERE "projectId" = ${projectId} AND "createdAt" >= ${since} AND (status = 'NO_ANSWER' OR helpful = false)
      ) q
      WHERE NOT EXISTS (
        SELECT 1 FROM docs_gap_dismissal d WHERE d."projectId" = ${projectId} AND d.question = q.key AND d."dismissedAt" >= q."createdAt"
      )
      GROUP BY q.key
      ORDER BY count(*) DESC, max(q."createdAt") DESC
      LIMIT 20`,
  ]);
  return {
    since: since.toISOString(),
    views: views._sum.views ?? 0,
    articles,
    comments: comments.map(({ comment, updatedAt, article }) => ({ article, comment: comment!, at: updatedAt.toISOString() })),
    searches: {
      total: searches._sum.searches ?? 0,
      failed: searches._sum.failed ?? 0,
      topFailed,
    },
    gaps: gaps.map((gap) => ({
      ...gap,
      lastAsked: gap.lastAsked.toISOString(),
      // "no_relevant_section", "no_valid_citation", "source_unpublished", "off_limits", "unknown" (asked before causes were kept), or null (only thumbs-downs).
      cause: (gap.cause?.toLowerCase() ?? null) as Lowercase<DocsNoAnswerCause> | null,
    })),
  };
}

export const gapFields = z.object({ question: z.string().trim().min(1).max(300) });

/** Hides a question from the Gaps list and the failed searches, as asked until now; asked again later, it's back. */
export async function dismissGap(projectId: string, question: string) {
  await prisma.$executeRaw`
    INSERT INTO docs_gap_dismissal ("projectId", question, "dismissedAt")
    VALUES (${projectId}, ${normalized(Prisma.sql`${question}`)}, now())
    ON CONFLICT ("projectId", question) DO UPDATE SET "dismissedAt" = now()`;
  return { dismissed: question };
}

export const dismissDocsGap = defineOperation({
  name: "docs.dismissGap",
  summary: "Dismiss a question from the gaps and the searches that found nothing in docs.insights (matched like the list groups them: case and spacing don't matter); asked again later, it's back",
  method: "POST",
  path: "/docs/gaps/dismiss",
  scope: "write",
  access: "team",
  input: gapFields,
  example: { question: "Can I pay with crypto?" },
  run: ({ projectId }, { question }) => dismissGap(projectId, question),
});

export const getDocsInsights = defineOperation({
  name: "docs.insights",
  summary: `How the docs did in the last ${INSIGHTS_DAYS} days: views, the top articles with how many readers found them helpful, the latest “No” comments, the searches that found nothing, and the gaps: questions the AI couldn't answer (with why, the latest time) or whose answer got a thumbs-down, grouped (case and spacing don't matter), with how many were passed to the team (docs.escalate)`,
  method: "GET",
  path: "/docs/insights",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => docsInsights(projectId),
});
