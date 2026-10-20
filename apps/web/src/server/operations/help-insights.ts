import { type HelpNoAnswerCause, Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";

/**
 * What readers make of the help center (Phase 10): their answers to "Was this helpful?",
 * article views and searches, summed up for the team. Feeds AI answers' gaps (Phase 11)
 * and the docs audit (Phase 12). Stores no IP addresses: see the models in schema.prisma.
 */

export const INSIGHTS_DAYS = 30;
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
export async function saveAnswer(projectId: string, readerId: string, input: z.infer<typeof answerFields>) {
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
      AND a.listing IN ('EVERYWHERE', 'UNLISTED')
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
  run: async (context, input) => saveAnswer(context.projectId, await authorId(context, input.author), input),
});

/** How the Gaps list groups questions (in SQL, so grouping and dismissing can't disagree): lowercase, trimmed, spaces collapsed. */
const normalized = (text: Prisma.Sql) => Prisma.sql`lower(btrim(regexp_replace(${text}, '[[:space:]]+', ' ', 'g')))`;

/** The team's numbers for the last INSIGHTS_DAYS days (help.insights and the app's insights page). */
export async function helpInsights(projectId: string) {
  // Whole days (UTC), today included, so daily view counts and timestamps cover the same span.
  const since = new Date(new Date().toISOString().slice(0, 10));
  since.setUTCDate(since.getUTCDate() - (INSIGHTS_DAYS - 1));
  const [views, articles, comments, searches, failed, topFailed, gaps] = await Promise.all([
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
    prisma.helpSearch.count({ where: { projectId, createdAt: { gte: since } } }),
    prisma.helpSearch.count({ where: { projectId, results: 0, createdAt: { gte: since } } }),
    prisma.helpSearch.groupBy({
      by: ["query"],
      where: { projectId, results: 0, createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: [{ _count: { query: "desc" } }, { query: "asc" }],
      take: 10,
    }),
    // Gaps: questions the AI couldn't answer or whose answer got a thumbs-down, grouped by
    // normalized question, without what the team dismissed (as asked up to the dismissal).
    // `cause`: why the latest "I don't know" in the group happened.
    prisma.$queryRaw<{ question: string; noAnswer: number; notHelpful: number; lastAsked: Date; answer: string | null; cause: string | null }[]>`
      SELECT
        (array_agg(q.question ORDER BY q."createdAt" DESC))[1] AS question,
        count(*) FILTER (WHERE q.status = 'NO_ANSWER')::int AS "noAnswer",
        (array_agg(q.cause::text ORDER BY q."createdAt" DESC) FILTER (WHERE q.status = 'NO_ANSWER'))[1] AS cause,
        count(*) FILTER (WHERE q.helpful = false)::int AS "notHelpful",
        max(q."createdAt") AS "lastAsked",
        (array_agg(q.answer ORDER BY q."createdAt" DESC) FILTER (WHERE q.helpful = false))[1] AS answer
      FROM (
        SELECT *, ${normalized(Prisma.raw("question"))} AS key FROM help_question
        WHERE "projectId" = ${projectId} AND "createdAt" >= ${since} AND (status = 'NO_ANSWER' OR helpful = false)
      ) q
      WHERE NOT EXISTS (
        SELECT 1 FROM help_gap_dismissal d WHERE d."projectId" = ${projectId} AND d.question = q.key AND d."dismissedAt" >= q."createdAt"
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
      total: searches,
      failed,
      topFailed: topFailed.map(({ query, _count }) => ({ query, count: _count._all })),
    },
    gaps: gaps.map((gap) => ({
      ...gap,
      lastAsked: gap.lastAsked.toISOString(),
      // "no_relevant_section", "no_valid_citation", "source_unpublished", "off_limits", "unknown" (asked before causes were kept), or null (only thumbs-downs).
      cause: (gap.cause?.toLowerCase() ?? null) as Lowercase<HelpNoAnswerCause> | null,
    })),
  };
}

export const gapFields = z.object({ question: z.string().trim().min(1).max(300) });

/** Hides a question from the Gaps list, as asked until now; asked again later, it's back. */
export async function dismissGap(projectId: string, question: string) {
  await prisma.$executeRaw`
    INSERT INTO help_gap_dismissal ("projectId", question, "dismissedAt")
    VALUES (${projectId}, ${normalized(Prisma.sql`${question}`)}, now())
    ON CONFLICT ("projectId", question) DO UPDATE SET "dismissedAt" = now()`;
  return { dismissed: question };
}

export const dismissHelpGap = defineOperation({
  name: "help.dismissGap",
  summary: "Dismiss a question from the gaps in help.insights (matched like the list groups them: case and spacing don't matter); asked again later, it's back",
  method: "POST",
  path: "/help/gaps/dismiss",
  scope: "write",
  access: "team",
  input: gapFields,
  example: { question: "Can I pay with crypto?" },
  run: ({ projectId }, { question }) => dismissGap(projectId, question),
});

export const getHelpInsights = defineOperation({
  name: "help.insights",
  summary: `How the help center did in the last ${INSIGHTS_DAYS} days: views, the top articles with how many readers found them helpful, the latest “No” comments, the searches that found nothing, and the gaps: questions the AI couldn't answer (with why, the latest time) or whose answer got a thumbs-down, grouped (case and spacing don't matter)`,
  method: "GET",
  path: "/help/insights",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => helpInsights(projectId),
});
