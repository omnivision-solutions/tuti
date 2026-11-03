import { Prisma, prisma } from "@tuti/db";
import { SEARCHES_KEPT_SINCE } from "@tuti/jobs";
import { z } from "zod";

import { DEFAULT_RANGE, RANGE_KEYS, type ReportRange, reportRange } from "@/lib/report-range";

import { awake } from "./conversations";
import { defineOperation } from "./define";
import { docsGaps, normalized } from "./docs-insights";

/**
 * Reporting: how the docs, the AI that answers from them and the inbox did over a range of whole UTC days (lib/report-range.ts, at most
 * a year: as long as searches are kept, the prune-docs-searches job), as daily counts and totals. Sample content
 * (server/sample-content.ts) left out.
 */

/** `rows` (a day and counts) as one array per count, a value for each of `days` (0 where there's no row). */
function daily<K extends string>(days: string[], rows: ({ day: Date } & Record<K, number>)[], keys: K[]) {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), row]));
  return Object.fromEntries(keys.map((key) => [key, days.map((day) => byDay.get(day)?.[key] ?? 0)])) as Record<K, number[]>;
}

/** How many searches that found nothing, and AI conversations, a report lists. */
const LISTED = 50;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Docs: views, searches and readers' answers to "Was this helpful?" by day, every published article's numbers, and what readers missed. */
export async function docsReport(projectId: string, { since, until, days }: ReportRange) {
  const [views, searches, answers, articles, comments, failedQueries] = await Promise.all([
    prisma.$queryRaw<{ day: Date; views: number }[]>`
      SELECT v.day, sum(v.views)::int AS views FROM article_view_day v JOIN article a ON a.id = v."articleId"
      WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL AND NOT a.sample AND v.day >= ${since}::date AND v.day < ${until}::date
      GROUP BY v.day`,
    prisma.docsSearchDay.findMany({ where: { projectId, day: { gte: since, lt: until } }, select: { day: true, searches: true, failed: true } }),
    // An answer counts on the day it was last given (answering again replaces it).
    prisma.$queryRaw<{ day: Date; helpful: number; notHelpful: number }[]>`
      SELECT f."updatedAt"::date AS day, count(*) FILTER (WHERE f.helpful)::int AS helpful, count(*) FILTER (WHERE NOT f.helpful)::int AS "notHelpful"
      FROM article_feedback f JOIN article a ON a.id = f."articleId"
      WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL AND NOT a.sample AND f."updatedAt" >= ${since} AND f."updatedAt" < ${until}
      GROUP BY 1`,
    // Published articles, and unpublished ones still read or answered lately.
    prisma.$queryRaw<{ slug: string; title: string; collection: string | null; published: boolean; views: number; helpful: number; notHelpful: number }[]>`
      SELECT * FROM (
        SELECT a.slug, a.title, c.name AS collection, a."publishedAt" IS NOT NULL AS published,
          (SELECT coalesce(sum(v.views), 0) FROM article_view_day v WHERE v."articleId" = a.id AND v.day >= ${since}::date AND v.day < ${until}::date)::int AS views,
          (SELECT count(*) FROM article_feedback f WHERE f."articleId" = a.id AND f.helpful AND f."updatedAt" >= ${since} AND f."updatedAt" < ${until})::int AS helpful,
          (SELECT count(*) FROM article_feedback f WHERE f."articleId" = a.id AND NOT f.helpful AND f."updatedAt" >= ${since} AND f."updatedAt" < ${until})::int AS "notHelpful"
        FROM article a LEFT JOIN collection c ON c.id = a."collectionId"
        WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL AND NOT a.sample
      ) s
      WHERE published OR views + helpful + "notHelpful" > 0
      ORDER BY views DESC, helpful + "notHelpful" DESC, title`,
    prisma.articleFeedback.findMany({
      where: { article: { projectId, deletedAt: null, sample: false }, helpful: false, comment: { not: null }, updatedAt: { gte: since, lt: until } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { comment: true, updatedAt: true, article: { select: { slug: true, title: true } } },
    }),
    // The LISTED most searched (the page counts the rest, so it adds up to Found nothing, as it does those past FAILED_SEARCHES_PER_DAY a
    // day, kept without their words). `before`: its searches
    // on the days up to its dismissal (docs.dismissGap, matched as Gaps match), which Home leaves out; ranked by the rest, as Home ranks
    // them, one dismissed with none since after the rest.
    prisma.$queryRaw<{ query: string; count: number; before: number }[]>`
      SELECT query, sum(count)::int AS count, (sum(count) FILTER (WHERE dismissed))::int AS before
      FROM (
        SELECT f.query, f.count, EXISTS (
          SELECT 1 FROM docs_gap_dismissal d
          WHERE d."projectId" = ${projectId} AND d.question = ${normalized(Prisma.raw("f.query"))} AND d."dismissedAt"::date >= f.day
        ) AS dismissed
        FROM docs_failed_search_day f
        WHERE f."projectId" = ${projectId} AND f.day >= ${since}::date AND f.day < ${until}::date
      ) f
      GROUP BY query
      ORDER BY sum(count) FILTER (WHERE NOT dismissed) DESC NULLS LAST, sum(count) DESC, query
      LIMIT ${LISTED}`,
  ]);
  const series = {
    ...daily(days, views, ["views"]),
    ...daily(days, searches, ["searches", "failed"]),
    ...daily(days, answers, ["helpful", "notHelpful"]),
  };
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: series,
    totals: {
      views: sum(series.views),
      searches: sum(series.searches),
      failedSearches: sum(series.failed),
      helpful: sum(series.helpful),
      notHelpful: sum(series.notHelpful),
      publishedArticles: articles.filter((article) => article.published).length,
    },
    /** The first day searches are counted on, when the range starts before it and ends after (older ones were pruned): `YYYY-MM-DD`, or null. */
    searchesSince: days[0]! < SEARCHES_KEPT_SINCE && days.at(-1)! >= SEARCHES_KEPT_SINCE ? SEARCHES_KEPT_SINCE : null,
    articles,
    /** The latest comments from readers who answered "No". */
    comments: comments.map(({ comment, updatedAt, article }) => ({ article, comment: comment!, at: updatedAt.toISOString() })),
    /**
     * Searches that found nothing (their words are the only ones kept), most often since any dismissal first: `before`, how many came
     * before it was dismissed (docs.dismissGap); `dismissed`, none since.
     */
    failedSearches: failedQueries.map(({ query, count, before }) => ({ query, count, before: before ?? 0, dismissed: (before ?? 0) === count })),
  };
}

export const AI_CONVERSATION_FILTERS = ["escalated", "unanswered"] as const;
export type AiConversationFilter = (typeof AI_CONVERSATION_FILTERS)[number];

/**
 * The docs' AI as support: each conversation with it (a question and its follow-ups, docs.ask's `followsId`) started in the report's days,
 * whether its answers came from the docs and whether the asker passed it to the team ("Ask a person"; with the inbox on it became a
 * conversation there). The latest LISTED with their turns, `show` picking the escalated ones or those with a question left unanswered.
 */
export async function aiReport(projectId: string, { since, until, days }: ReportRange, show?: AiConversationFilter) {
  const shown = show === "escalated" ? Prisma.sql`escalated` : show === "unanswered" ? Prisma.sql`answered < turns` : Prisma.sql`true`;
  // One row per conversation started in the range's days (`c`, worked out once), with its turns in them (a follow-up after the range
  // isn't the range's), then its days' counts and the latest LISTED. Each step reads only those days (the (projectId, createdAt) index).
  // As JSON, a day is "YYYY-MM-DD" and the last question's time is given in UTC.
  const [{ byDay, listed }] = await prisma.$queryRaw<
    [
      {
        byDay: { day: string; handled: number; escalated: number; answered: number; helpful: number; notHelpful: number }[];
        listed: { id: string; lastAt: string; askerId: string; source: string; ids: string[]; turns: number; answered: number; escalated: boolean; helpful: number; notHelpful: number }[];
      },
    ]
  >`
    WITH RECURSIVE thread AS (
      SELECT q.id, q.id AS root, 1 AS turn FROM docs_question q
      WHERE q."projectId" = ${projectId} AND q."followsId" IS NULL AND q."createdAt" >= ${since} AND q."createdAt" < ${until}
      UNION ALL
      SELECT q.id, t.root, t.turn + 1 FROM docs_question q JOIN thread t ON q."followsId" = t.id
      WHERE q."projectId" = ${projectId} AND q."createdAt" >= ${since} AND q."createdAt" < ${until}
    ), c AS MATERIALIZED (
      SELECT t.root AS id,
        min(q."createdAt")::date AS day,
        max(q."createdAt") AT TIME ZONE 'UTC' AS "lastAt",
        (array_agg(q."askerId" ORDER BY t.turn))[1] AS "askerId",
        (array_agg(q.source::text ORDER BY t.turn))[1] AS source,
        array_agg(q.id ORDER BY t.turn) AS ids,
        count(*)::int AS turns,
        count(*) FILTER (WHERE q.status = 'ANSWERED')::int AS answered,
        bool_or(q."escalatedAt" IS NOT NULL) AS escalated,
        count(*) FILTER (WHERE q.helpful)::int AS helpful,
        count(*) FILTER (WHERE q.helpful = false)::int AS "notHelpful"
      FROM thread t JOIN docs_question q ON q.id = t.id
      GROUP BY t.root
    )
    SELECT
      (SELECT coalesce(json_agg(d), '[]') FROM (
        SELECT day,
          count(*) FILTER (WHERE NOT escalated)::int AS handled,
          count(*) FILTER (WHERE escalated)::int AS escalated,
          count(*) FILTER (WHERE answered = turns)::int AS answered,
          count(*) FILTER (WHERE helpful > 0)::int AS helpful,
          count(*) FILTER (WHERE "notHelpful" > 0)::int AS "notHelpful"
        FROM c GROUP BY day
      ) d) AS "byDay",
      (SELECT coalesce(json_agg(l ORDER BY l."lastAt" DESC), '[]') FROM (
        SELECT * FROM c WHERE ${shown} ORDER BY "lastAt" DESC LIMIT ${LISTED}
      ) l) AS listed`;
  const series = daily(
    days,
    byDay.map((row) => ({ ...row, day: new Date(row.day) })),
    ["handled", "escalated", "answered", "helpful", "notHelpful"],
  );
  const [turns, askers] = await Promise.all([
    prisma.docsQuestion.findMany({
      where: { id: { in: listed.flatMap((thread) => thread.ids) } },
      select: { id: true, question: true, answer: true, status: true, helpful: true, escalatedAt: true },
    }),
    // Who asked, where they're someone Tuti knows (a signed-in reader); others are an anonymous reader or an API key.
    prisma.user.findMany({ where: { id: { in: listed.map((thread) => thread.askerId) } }, select: { id: true, name: true } }),
  ]);
  const turnOf = new Map(turns.map((turn) => [turn.id, turn]));
  const nameOf = new Map(askers.map((asker) => [asker.id, asker.name]));
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: { handled: series.handled, escalated: series.escalated },
    totals: {
      conversations: sum(series.handled) + sum(series.escalated),
      escalated: sum(series.escalated),
      /** Conversations where every question got an answer from the docs. */
      answered: sum(series.answered),
      /** Conversations with a thumbs up, and with a thumbs down. */
      helpful: sum(series.helpful),
      notHelpful: sum(series.notHelpful),
    },
    conversations: listed.map((thread) => ({
      id: thread.id,
      lastAt: new Date(thread.lastAt).toISOString(),
      source: thread.source.toLowerCase() as "portal" | "widget" | "api",
      asker: nameOf.get(thread.askerId) ?? null,
      escalated: thread.escalated,
      answered: thread.answered,
      helpful: thread.helpful,
      notHelpful: thread.notHelpful,
      turns: thread.ids.flatMap((id) => {
        const turn = turnOf.get(id);
        return turn
          ? [{ question: turn.question, answer: turn.answer, status: turn.status.toLowerCase() as "answered" | "no_answer" | "failed", helpful: turn.helpful, escalated: !!turn.escalatedAt }]
          : [];
      }),
    })),
  };
}

/** The inbox: new conversations by day and where they began, how soon the team first replied, what's open now, and each teammate's replies. */
export async function inboxReport(projectId: string, { since, until, days }: ReportRange) {
  const counted = { projectId, spam: false, sample: false };
  const [created, origins, firstReply, open, replies] = await Promise.all([
    prisma.$queryRaw<{ day: Date; created: number }[]>`
      SELECT "createdAt"::date AS day, count(*)::int AS created FROM conversation
      WHERE "projectId" = ${projectId} AND NOT spam AND NOT sample AND "createdAt" >= ${since} AND "createdAt" < ${until}
      GROUP BY 1`,
    prisma.conversation.groupBy({ by: ["origin"], where: { ...counted, createdAt: { gte: since, lt: until } }, _count: true }),
    // From a conversation's start to the team's first reply (not a note), for those started in the report's days.
    prisma.$queryRaw<[{ replied: number; median: number | null }]>`
      SELECT count(r.first)::int AS replied,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.first - c."createdAt")) AS median
      FROM conversation c
      LEFT JOIN LATERAL (
        SELECT min(m."createdAt") AS first FROM conversation_message m WHERE m."conversationId" = c.id AND m.author = 'TEAM' AND NOT m.note
      ) r ON true
      WHERE c."projectId" = ${projectId} AND NOT c.spam AND NOT c.sample AND c."createdAt" >= ${since} AND c."createdAt" < ${until}`,
    // As the inbox counts what needs a reply: snoozed ones aren't.
    prisma.conversation.count({ where: { ...counted, status: "OPEN", ...awake() } }),
    prisma.$queryRaw<{ id: string | null; name: string | null; replies: number; conversations: number }[]>`
      SELECT u.id, u.name, count(*)::int AS replies, count(DISTINCT m."conversationId")::int AS conversations
      FROM conversation_message m JOIN conversation c ON c.id = m."conversationId" LEFT JOIN "user" u ON u.id = m."authorId"
      WHERE m."projectId" = ${projectId} AND m.author = 'TEAM' AND NOT m.note AND m."createdAt" >= ${since} AND m."createdAt" < ${until} AND NOT c.spam AND NOT c.sample
      GROUP BY u.id, u.name
      ORDER BY replies DESC, u.name`,
  ]);
  const series = daily(days, created, ["created"]);
  const byOrigin = Object.fromEntries(origins.map((row) => [row.origin.toLowerCase(), row._count]));
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: series,
    totals: {
      conversations: sum(series.created),
      /** Started by "Ask a person" after an AI answer. */
      fromAi: byOrigin.escalation ?? 0,
      replied: firstReply[0].replied,
      /** Seconds to the team's first reply, the median of those replied to; null with none. */
      medianFirstReply: firstReply[0].median === null ? null : Math.round(firstReply[0].median),
      /** Open now, whatever the range. */
      openNow: open,
    },
    origins: { widget: byOrigin.widget ?? 0, email: byOrigin.email ?? 0, escalation: byOrigin.escalation ?? 0, api: byOrigin.api ?? 0 },
    /** Each teammate's replies (a teammate who left: `id` null). */
    teammates: replies,
  };
}

export const getReports = defineOperation({
  name: "reports.get",
  summary: `How a range of days went (\`range\`: ${RANGE_KEYS.join(", ")}; the past 30 days by default), by day (UTC) and in total: the docs (views, searches and those that found nothing, readers' answers to “Was this helpful?”, each article's numbers), the AI's conversations from the docs (answered, passed to the team, thumbs up and down, the latest ones, the questions it couldn't answer) and the inbox (new conversations by where they began, the median time to the team's first reply, open now, replies per teammate)`,
  method: "GET",
  path: "/reports",
  scope: "read",
  access: "team",
  input: z.object({ range: z.enum(RANGE_KEYS).default(DEFAULT_RANGE) }),
  example: { range: "7d" },
  run: async ({ projectId }, input) => {
    const range = reportRange(input.range);
    const [docs, ai, gaps, inbox] = await Promise.all([
      docsReport(projectId, range),
      aiReport(projectId, range),
      docsGaps(projectId, range.since, range.until),
      inboxReport(projectId, range),
    ]);
    // `gaps`: questions the AI couldn't answer or whose answer got a thumbs-down, grouped (Reporting's Unanswered questions; as docs.insights' gaps).
    return { docs, ai: { ...ai, gaps }, inbox };
  },
});
