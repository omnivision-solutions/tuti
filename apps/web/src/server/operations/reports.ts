import { Prisma, prisma } from "@tuti/db";
import { historySince, SEARCHES_KEPT_DAYS } from "@tuti/jobs";
import { historyKeptDays, type PlanKey, reportingDays, reportingRangeNeeded } from "@tuti/shared";
import { z } from "zod";

import { DEFAULT_RANGE, RANGE_KEYS, type RangeKey, type ReportRange, reportRange } from "@/lib/report-range";

import { awake } from "./conversations";
import { defineOperation, OperationError } from "./define";
import { docsGaps, normalized } from "./docs-insights";
import { requirePlan } from "./plan";

/**
 * Reporting: how the docs, the AI that answers from them and the inbox did over a range of whole UTC days (lib/report-range.ts, at most
 * a year: as long as searches are kept, the prune-docs-searches job), as daily counts and totals. Sample content
 * (server/sample-content.ts) left out.
 */

/** The ranges a project on `plan` can't pick: those longer than reportingDays (Pro: a month). */
export const lockedRanges = (plan: PlanKey): RangeKey[] => {
  const max = reportingDays(plan);
  return max === null ? [] : RANGE_KEYS.filter((key) => reportRange(key).days.length > max);
};

/** The range a project on `plan` sees unless it picks one: the default, or where that's locked the longest it has. */
export function defaultRange(plan: PlanKey): RangeKey {
  const locked = lockedRanges(plan);
  if (!locked.includes(DEFAULT_RANGE)) {
    return DEFAULT_RANGE;
  }
  const open = RANGE_KEYS.filter((key) => !locked.includes(key));
  return open.reduce((longest, key) => (reportRange(key).days.length > reportRange(longest).days.length ? key : longest), open[0] ?? DEFAULT_RANGE);
}

/** `rows` (a day and counts) as one array per count, a value for each of `days` (0 where there's no row). */
function daily<K extends string>(days: string[], rows: ({ day: Date } & Record<K, number>)[], keys: K[]) {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), row]));
  return Object.fromEntries(keys.map((key) => [key, days.map((day) => byDay.get(day)?.[key] ?? 0)])) as Record<K, number[]>;
}

/**
 * As daily, for `rows` over the range's previous days and its own (queried from `previous.since` to `until`): the range's days' counts,
 * and the previous days' totals (Reporting's tiles compare the two). While the range's last day (today) is under way, the previous days'
 * last counts only as much of it as today has had (so they may be fractions), so a steady day reads as the same.
 * ponytail: that part is pro rata (as if a day's counts came evenly); cut timestamped rows at the same time of day if it matters.
 */
function dailyAndBefore<K extends string>({ days, until, previous }: ReportRange, rows: ({ day: Date } & Record<K, number>)[], keys: K[]) {
  const both = daily([...previous.days, ...days], rows, keys);
  const passed = Math.min(1, Math.max(0, (Date.now() - (until.getTime() - DAY)) / DAY));
  const series = Object.fromEntries(keys.map((key) => [key, both[key].slice(previous.days.length)])) as Record<K, number[]>;
  const before = Object.fromEntries(
    keys.map((key) => {
      const values = both[key].slice(0, previous.days.length);
      // Unrounded: the tiles compare shares of these (answered of conversations), which rounding each could make more than whole.
      return [key, sum(values.slice(0, -1)) + values.at(-1)! * passed];
    }),
  ) as Record<K, number>;
  return { series, before };
}

const DAY = 86_400_000;

/**
 * Whether conversations and AI questions from the range's previous days are all still kept (the daily delete-old-history job deletes
 * them after historyKeptDays: a year by default, never without plans), so they can be compared with the range's.
 */
const previousKept = ({ previous }: ReportRange) => {
  const kept = historyKeptDays();
  return kept === null || previous.since.getTime() >= Date.now() - kept * DAY;
};

/** How many searches that found nothing, and AI conversations, a report lists. */
const LISTED = 50;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Docs: views, searches and readers' answers to "Was this helpful?" by day, every published article's numbers, and what readers missed. */
export async function docsReport(projectId: string, range: ReportRange) {
  const { since, until, days, previous } = range;
  const [views, searches, answers, articles, comments, failedQueries, installation] = await Promise.all([
    prisma.$queryRaw<{ day: Date; views: number }[]>`
      SELECT v.day, sum(v.views)::int AS views FROM article_view_day v JOIN article a ON a.id = v."articleId"
      WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL AND NOT a.sample AND v.day >= ${previous.since}::date AND v.day < ${until}::date
      GROUP BY v.day`,
    prisma.docsSearchDay.findMany({ where: { projectId, day: { gte: previous.since, lt: until } }, select: { day: true, searches: true, failed: true } }),
    // An answer counts on the day it was last given (answering again replaces it).
    prisma.$queryRaw<{ day: Date; helpful: number; notHelpful: number }[]>`
      SELECT f."updatedAt"::date AS day, count(*) FILTER (WHERE f.helpful)::int AS helpful, count(*) FILTER (WHERE NOT f.helpful)::int AS "notHelpful"
      FROM article_feedback f JOIN article a ON a.id = f."articleId"
      WHERE a."projectId" = ${projectId} AND a."deletedAt" IS NULL AND NOT a.sample AND f."updatedAt" >= ${previous.since} AND f."updatedAt" < ${until}
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
    // `topics`: every query searched since its dismissal, if any (on each row: counted before the LIMIT).
    prisma.$queryRaw<{ query: string; count: number; before: number; topics: number }[]>`
      SELECT query, sum(count)::int AS count, (sum(count) FILTER (WHERE dismissed))::int AS before,
        (sum((count(*) FILTER (WHERE NOT dismissed) > 0)::int) OVER ())::int AS topics
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
    prisma.installation.findUnique({ where: { singleton: 1 }, select: { searchesKeptAt: true } }),
  ]);
  // Searches survive from 29 days before this server started keeping them a year (the 30-day pruning kept those): YYYY-MM-DD. With
  // inline jobs (JOBS_DRIVER=inline) nothing was ever pruned, so they all are.
  const pruned = process.env.JOBS_DRIVER !== "inline";
  const keptSince = installation && pruned && new Date(installation.searchesKeptAt.getTime() - 29 * DAY).toISOString().slice(0, 10);
  // And no further back than SEARCHES_KEPT_DAYS (prune-docs-searches keeps today and the days before it).
  const keptFrom = pruned ? new Date(Date.parse(new Date().toISOString().slice(0, 10)) - (SEARCHES_KEPT_DAYS - 1) * DAY).toISOString().slice(0, 10) : null;
  const [viewed, searched, answered] = [
    dailyAndBefore(range, views, ["views"]),
    dailyAndBefore(range, searches, ["searches", "failed"]),
    dailyAndBefore(range, answers, ["helpful", "notHelpful"]),
  ];
  const series = { ...viewed.series, ...searched.series, ...answered.series };
  // Searches before those kept (pruned) aren't compared: the previous days' would be too few.
  const searchesBefore = [keptSince, keptFrom].some((kept) => kept && previous.days[0]! < kept) ? null : searched.before;
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: series,
    totals: {
      views: sum(series.views),
      searches: sum(series.searches),
      failedSearches: sum(series.failed),
      /** The different words of searches that found nothing, without those dismissed with none since: topics to write about. */
      failedTopics: failedQueries[0]?.topics ?? 0,
      helpful: sum(series.helpful),
      notHelpful: sum(series.notHelpful),
      publishedArticles: articles.filter((article) => article.published).length,
    },
    /** The same totals over the previous days (ReportRange's `previous`); searches null where some of those days' were pruned. */
    before: {
      views: viewed.before.views,
      searches: searchesBefore?.searches ?? null,
      failedSearches: searchesBefore?.failed ?? null,
      helpful: answered.before.helpful,
      notHelpful: answered.before.notHelpful,
    },
    /** The first day searches are counted on, when the range starts before it (older ones were pruned): `YYYY-MM-DD`, or null. */
    searchesSince: keptSince && days[0]! < keptSince ? keptSince : null,
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
 * conversation there). The latest with their turns, `perPage` of them from `page` (1, the latest LISTED, unless given), `show`
 * picking the escalated ones or those with a question left unanswered; `listed`, how many there are to page through.
 */
export async function aiReport(projectId: string, range: ReportRange, show?: AiConversationFilter, { page = 1, perPage = LISTED } = {}) {
  const { since, until, days, previous } = range;
  const shown = show === "escalated" ? Prisma.sql`escalated` : show === "unanswered" ? Prisma.sql`answered < turns` : Prisma.sql`true`;
  // Listed: those asked in since the plan's history starts (its counts are left as they are).
  const history = await historySince(projectId);
  const recent = history ? Prisma.sql`"lastAt" >= ${history}` : Prisma.sql`true`;
  // One row per conversation started in the range's days or the previous ones (`c`, worked out once; `current`, the range's), with its
  // turns in its own days (a follow-up after them isn't theirs), then each day's counts and the range's latest LISTED. Each step reads only
  // those days (the (projectId, createdAt) index). As JSON, a day is "YYYY-MM-DD" and the last question's time is given in UTC.
  const [{ byDay, listed, pastHistory, listedCount }] = await prisma.$queryRaw<
    [
      {
        byDay: { day: string; handled: number; escalated: number; answered: number; helpful: number; notHelpful: number; rated: number }[];
        pastHistory: number;
        listedCount: number;
        listed: { id: string; lastAt: string; askerId: string; source: string; ids: string[]; turns: number; answered: number; escalated: boolean; helpful: number; notHelpful: number }[];
      },
    ]
  >`
    WITH RECURSIVE thread AS (
      SELECT q.id, q.id AS root, 1 AS turn, q."createdAt" >= ${since} AS current FROM docs_question q
      WHERE q."projectId" = ${projectId} AND q."followsId" IS NULL AND q."createdAt" >= ${previous.since} AND q."createdAt" < ${until}
      UNION ALL
      SELECT q.id, t.root, t.turn + 1, t.current FROM docs_question q JOIN thread t ON q."followsId" = t.id
      WHERE q."projectId" = ${projectId} AND q."createdAt" >= ${previous.since} AND q."createdAt" < ${until} AND (t.current OR q."createdAt" < ${since})
    ), c AS MATERIALIZED (
      SELECT t.root AS id, bool_and(t.current) AS current,
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
          count(*) FILTER (WHERE "notHelpful" > 0)::int AS "notHelpful",
          count(*) FILTER (WHERE helpful > 0 OR "notHelpful" > 0)::int AS rated
        FROM c GROUP BY day
      ) d) AS "byDay",
      (SELECT count(*) FROM c WHERE current AND ${shown} AND NOT ${recent})::int AS "pastHistory",
      (SELECT count(*) FROM c WHERE current AND ${shown} AND ${recent})::int AS "listedCount",
      (SELECT coalesce(json_agg(l ORDER BY l."lastAt" DESC, l.id), '[]') FROM (
        SELECT * FROM c WHERE current AND ${shown} AND ${recent} ORDER BY "lastAt" DESC, id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
      ) l) AS listed`;
  const { series, before } = dailyAndBefore(
    range,
    byDay.map((row) => ({ ...row, day: new Date(row.day) })),
    ["handled", "escalated", "answered", "helpful", "notHelpful", "rated"],
  );
  const [turns, askers] = await Promise.all([
    prisma.docsQuestion.findMany({
      where: { id: { in: listed.flatMap((thread) => thread.ids) } },
      select: { id: true, question: true, answer: true, status: true, helpful: true, escalatedAt: true, conversationId: true },
    }),
    // Who asked, where they're someone Tuti knows (a signed-in reader); others are an anonymous reader or an API key.
    prisma.user.findMany({ where: { id: { in: listed.map((thread) => thread.askerId) } }, select: { id: true, name: true } }),
  ]);
  // The Inbox conversations those passed to the team started (one deleted with old history: none).
  const started = await prisma.conversation.findMany({
    where: { projectId, id: { in: turns.flatMap((turn) => (turn.conversationId ? [turn.conversationId] : [])) } },
    select: { id: true, number: true },
  });
  const numberOf = new Map(started.map((conversation) => [conversation.id, conversation.number]));
  const turnOf = new Map(turns.map((turn) => [turn.id, turn]));
  const nameOf = new Map(askers.map((asker) => [asker.id, asker.name]));
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: series,
    totals: {
      conversations: sum(series.handled) + sum(series.escalated),
      escalated: sum(series.escalated),
      /** Conversations where every question got an answer from the docs. */
      answered: sum(series.answered),
      /** Conversations with a thumbs up, and with a thumbs down. */
      helpful: sum(series.helpful),
      notHelpful: sum(series.notHelpful),
      /** Conversations with a thumbs up or down (one with both, once). */
      rated: sum(series.rated),
    },
    /** The same totals over the previous days (ReportRange's `previous`); null where some of their questions were deleted (previousKept). */
    before: previousKept(range)
      ? {
          conversations: before.handled + before.escalated,
          escalated: before.escalated,
          answered: before.answered,
          helpful: before.helpful,
          notHelpful: before.notHelpful,
          rated: before.rated,
        }
      : null,
    /** Conversations `show` would list but the plan's history leaves out (counted above all the same). */
    pastHistory,
    /** How many `show` lists, on every page. */
    listed: listedCount,
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
          ? [
              {
                question: turn.question,
                answer: turn.answer,
                status: turn.status.toLowerCase() as "answered" | "no_answer" | "failed",
                helpful: turn.helpful,
                escalated: !!turn.escalatedAt,
                /** The Inbox conversation it started (its number), when passed to the team. */
                conversation: (turn.conversationId && numberOf.get(turn.conversationId)) || null,
              },
            ]
          : [];
      }),
    })),
  };
}

/** The inbox: new conversations by day and where they began, how soon the team first replied, what's open now, and each teammate's replies. */
export async function inboxReport(projectId: string, range: ReportRange) {
  const { since, until, days, previous } = range;
  const counted = { projectId, spam: false, sample: false };
  // From a conversation's start to the team's first reply (not a note), for those started from `from` up to `to` and replied to before
  // `by`.
  const firstReplies = (from: Date, to: Date, by: Date) => prisma.$queryRaw<[{ replied: number; median: number | null }]>`
    SELECT count(r.first)::int AS replied,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.first - c."createdAt")) AS median
    FROM conversation c
    LEFT JOIN LATERAL (
      SELECT min(m."createdAt") AS first FROM conversation_message m WHERE m."conversationId" = c.id AND m.author = 'TEAM' AND NOT m.note AND m."createdAt" < ${by}
    ) r ON true
    WHERE c."projectId" = ${projectId} AND NOT c.spam AND NOT c.sample AND c."createdAt" >= ${from} AND c."createdAt" < ${to}`;
  const [created, origins, firstReply, firstReplyBefore, open, replies] = await Promise.all([
    prisma.$queryRaw<{ day: Date; created: number; fromAi: number }[]>`
      SELECT "createdAt"::date AS day, count(*)::int AS created, count(*) FILTER (WHERE origin = 'ESCALATION')::int AS "fromAi" FROM conversation
      WHERE "projectId" = ${projectId} AND NOT spam AND NOT sample AND "createdAt" >= ${previous.since} AND "createdAt" < ${until}
      GROUP BY 1`,
    prisma.conversation.groupBy({ by: ["origin"], where: { ...counted, createdAt: { gte: since, lt: until } }, _count: true }),
    firstReplies(since, until, new Date()),
    // The previous days' given no longer to be replied to than the range's have had (all of them till now): a reply after it isn't one.
    firstReplies(previous.since, since, new Date(Date.now() - (since.getTime() - previous.since.getTime()))),
    // As the inbox counts what needs a reply (the tile opens Needs reply): snoozed ones aren't, nor those the AI has.
    prisma.conversation.count({ where: { ...counted, handledBy: "TEAM", status: "OPEN", ...awake() } }),
    prisma.$queryRaw<{ id: string | null; name: string | null; replies: number; conversations: number }[]>`
      SELECT u.id, u.name, count(*)::int AS replies, count(DISTINCT m."conversationId")::int AS conversations
      FROM conversation_message m JOIN conversation c ON c.id = m."conversationId" LEFT JOIN "user" u ON u.id = m."authorId"
      WHERE m."projectId" = ${projectId} AND m.author = 'TEAM' AND NOT m.note AND m."createdAt" >= ${since} AND m."createdAt" < ${until} AND NOT c.spam AND NOT c.sample
      GROUP BY u.id, u.name
      ORDER BY replies DESC, u.name`,
  ]);
  const { series, before } = dailyAndBefore(range, created, ["created", "fromAi"]);
  const median = ([{ median }]: [{ median: number | null }]) => (median === null ? null : Math.round(median));
  const byOrigin = Object.fromEntries(origins.map((row) => [row.origin.toLowerCase(), row._count]));
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days,
    daily: series,
    totals: {
      conversations: sum(series.created),
      /** Started by "Ask a person" after an AI answer. */
      fromAi: sum(series.fromAi),
      replied: firstReply[0].replied,
      /** Seconds to the team's first reply, the median of those replied to; null with none. */
      medianFirstReply: median(firstReply),
      /** Open now, whatever the range. */
      openNow: open,
    },
    /** The same totals over the previous days (ReportRange's `previous`; open now has none); null where some were deleted (previousKept). */
    before: previousKept(range) ? { conversations: before.created, fromAi: before.fromAi, medianFirstReply: median(firstReplyBefore) } : null,
    origins: { widget: byOrigin.widget ?? 0, email: byOrigin.email ?? 0, escalation: byOrigin.escalation ?? 0, api: byOrigin.api ?? 0 },
    /** Each teammate's replies (a teammate who left: `id` null). */
    teammates: replies,
  };
}

/** What reports.get returns: each part's days, then its numbers. */
const n = (description: string, example: number) => z.number().describe(description).meta({ examples: [example] });
const counts = (description: string, example: number) => z.array(z.number().int()).describe(description).meta({ examples: [[example, example + 3]] });
const rangeFields = {
  since: z.string().describe("The range's first day, 00:00 UTC (ISO 8601)").meta({ examples: ["2026-10-21T00:00:00.000Z"] }),
  until: z.string().describe("The day after its last, 00:00 UTC (ISO 8601)").meta({ examples: ["2026-11-20T00:00:00.000Z"] }),
  days: z.array(z.string()).describe("Each day of the range (UTC), YYYY-MM-DD: the daily counts' days, in order").meta({ examples: [["2026-11-18", "2026-11-19"]] }),
};
const BEFORE =
  "The same totals over as many days just before the range, to compare with. While today is under way, the last of them counts only as much of it as today has had, so these are possibly fractions";
const reportsOutput = z
  .object({
    docs: z
      .object({
        ...rangeFields,
        daily: z
          .object({
            views: counts("Article views", 120),
            searches: counts("Searches", 40),
            failed: counts("Searches that found nothing", 3),
            helpful: counts("Readers' answers “Yes” to “Was this helpful?”", 6),
            notHelpful: counts("Readers' answers “No”", 1),
          })
          .describe("Each count by day, one value for each of `days`"),
        totals: z
          .object({
            views: n("Article views", 3600),
            searches: n("Searches", 1200),
            failedSearches: n("Searches that found nothing", 90),
            failedTopics: n("The different words of searches that found nothing, without those dismissed with none since: topics to write about", 12),
            helpful: n("Readers' answers “Yes” to “Was this helpful?”", 180),
            notHelpful: n("Readers' answers “No”", 25),
            publishedArticles: n("Articles published now", 42),
          })
          .describe("The range's totals"),
        before: z
          .object({
            views: n("Article views", 3100.5),
            searches: z.number().nullable().describe("Searches; null where theirs were deleted for some of those days").meta({ examples: [1100] }),
            failedSearches: z.number().nullable().describe("Searches that found nothing; null where some of those days' were deleted").meta({ examples: [95] }),
            helpful: n("Answers “Yes”", 160),
            notHelpful: n("Answers “No”", 30),
          })
          .describe(BEFORE),
        searchesSince: z
          .string()
          .nullable()
          .describe("The first day searches are counted on, YYYY-MM-DD, when the range starts before it (older ones were deleted); null otherwise")
          .meta({ examples: [null] }),
        articles: z
          .array(
            z.object({
              slug: z.string().describe("The article's slug").meta({ examples: ["invite-your-team"] }),
              title: z.string().describe("Its title").meta({ examples: ["Invite your team"] }),
              collection: z.string().nullable().describe("Its collection's name, or null").meta({ examples: ["Getting started"] }),
              published: z.boolean().describe("Whether it's published").meta({ examples: [true] }),
              views: n("Its views in the range", 420),
              helpful: n("Answers “Yes” on it in the range", 18),
              notHelpful: n("Answers “No” on it in the range", 2),
            }),
          )
          .describe("Each article's numbers: published ones, and unpublished ones read or answered in the range; most viewed first"),
        comments: z
          .array(
            z.object({
              article: z
                .object({
                  slug: z.string().describe("The article's slug").meta({ examples: ["invite-your-team"] }),
                  title: z.string().describe("Its title").meta({ examples: ["Invite your team"] }),
                })
                .describe("The article it's on"),
              comment: z.string().describe("What the reader wrote").meta({ examples: ["It doesn't say how to remove someone"] }),
              at: z.string().describe("When (ISO 8601)").meta({ examples: ["2026-11-18T14:02:00.000Z"] }),
            }),
          )
          .describe("The latest 20 comments from readers who answered “No”, newest first"),
        failedSearches: z
          .array(
            z.object({
              query: z.string().describe("What was searched (their words are the only ones kept)").meta({ examples: ["export to csv"] }),
              count: n("How many times", 14),
              before: n("How many came before it was dismissed (docs.dismissGap)", 0),
              dismissed: z.boolean().describe("Dismissed, with none since").meta({ examples: [false] }),
            }),
          )
          .describe("The 50 searches that found nothing most often, those since any dismissal first"),
      })
      .describe("The docs: views, searches and those that found nothing, readers' answers to “Was this helpful?”, and each article's numbers"),
    ai: z
      .object({
        ...rangeFields,
        daily: z
          .object({
            handled: counts("Conversations the AI handled alone", 30),
            escalated: counts("Conversations passed to the team (“Ask a person”)", 2),
            answered: counts("Conversations where every question got an answer from the docs", 26),
            helpful: counts("Conversations with a thumbs up", 5),
            notHelpful: counts("Conversations with a thumbs down", 1),
            rated: counts("Conversations with a thumbs up or down (one with both, once)", 6),
          })
          .describe("Each count by day (a conversation counts on the day it began), one value for each of `days`"),
        totals: z
          .object({
            conversations: n("Conversations with the AI", 960),
            escalated: n("Passed to the team (“Ask a person”)", 60),
            answered: n("Where every question got an answer from the docs", 820),
            helpful: n("With a thumbs up", 150),
            notHelpful: n("With a thumbs down", 30),
            rated: n("With a thumbs up or down (one with both, once)", 175),
          })
          .describe("The range's totals"),
        before: z
          .object({
            conversations: n("Conversations with the AI", 900.5),
            escalated: n("Passed to the team", 55),
            answered: n("Answered from the docs", 760),
            helpful: n("With a thumbs up", 140),
            notHelpful: n("With a thumbs down", 35),
            rated: n("With a thumbs up or down", 170),
          })
          .nullable()
          .describe(`${BEFORE}. Null where some of their questions were deleted, as Past year's are on servers with plans`),
        pastHistory: n("Conversations the plan's history leaves out of the list (counted above all the same)", 0),
        listed: n("How many conversations there are to list", 960),
        conversations: z
          .array(
            z.object({
              id: z.string().describe("The conversation's id: its first question's").meta({ examples: ["cm3question0001"] }),
              lastAt: z.string().describe("When its last question was asked (ISO 8601)").meta({ examples: ["2026-11-19T08:41:00.000Z"] }),
              source: z.enum(["portal", "widget", "api"]).describe("Where it was asked: the portal, the widget or the API (docs.ask)").meta({ examples: ["widget"] }),
              asker: z.string().nullable().describe("Who asked, when a signed-in reader; null for an anonymous reader or an API key").meta({ examples: ["Riley Reader"] }),
              escalated: z.boolean().describe("Whether it was passed to the team").meta({ examples: [false] }),
              answered: n("Its questions answered from the docs", 2),
              helpful: n("Its thumbs up", 1),
              notHelpful: n("Its thumbs down", 0),
              turns: z
                .array(
                  z.object({
                    question: z.string().describe("The question").meta({ examples: ["How do I invite my team?"] }),
                    answer: z.string().nullable().describe("The AI's answer, or null without one").meta({ examples: ["Open Settings → Team and choose Invite."] }),
                    status: z
                      .enum(["answered", "no_answer", "failed"])
                      .describe("answered (from the docs), no_answer (the docs couldn't answer it) or failed")
                      .meta({ examples: ["answered"] }),
                    helpful: z.boolean().nullable().describe("The asker's thumbs up (true) or down (false), or null").meta({ examples: [true] }),
                    escalated: z.boolean().describe("Whether this question was passed to the team").meta({ examples: [false] }),
                    conversation: z
                      .number()
                      .int()
                      .nullable()
                      .describe("The Inbox conversation it started (its number), when passed to the team")
                      .meta({ examples: [null] }),
                  }),
                )
                .describe("Its questions, in order: the first and its follow-ups"),
            }),
          )
          .describe("The latest 50 conversations, newest first"),
        gaps: z
          .array(
            z.object({
              question: z.string().describe("The latest asking of the question").meta({ examples: ["Can I export to CSV?"] }),
              noAnswer: n("How many times the AI couldn't answer it", 4),
              notHelpful: n("How many of its answers got a thumbs down", 1),
              escalated: n("How many were passed to the team", 2),
              lastAsked: z.string().describe("When it was last asked (ISO 8601)").meta({ examples: ["2026-11-19T08:41:00.000Z"] }),
              answer: z.string().nullable().describe("The latest answer that got a thumbs down, or null").meta({ examples: [null] }),
              cause: z
                .enum(["no_relevant_section", "no_valid_citation", "source_unpublished", "off_limits", "unknown"])
                .nullable()
                .describe("Why the latest “I don't know” happened (unknown: asked before causes were kept), or null with only thumbs down")
                .meta({ examples: ["no_relevant_section"] }),
              follows: z.string().nullable().describe("The question it followed up on, or null").meta({ examples: [null] }),
              article: z
                .object({
                  slug: z.string().describe("The article's slug").meta({ examples: ["export-data"] }),
                  title: z.string().describe("Its title").meta({ examples: ["Export your data"] }),
                })
                .nullable()
                .describe("The first article the latest unhelpful answer cited (the one to improve), or null")
                .meta({ examples: [null] }),
            }),
          )
          .describe("The 20 questions it couldn't answer, or whose answer got a thumbs down, asked most first (without those dismissed)"),
      })
      .describe("The AI that answers from the docs: its conversations, answered or passed to the team, thumbs up and down, the latest ones, and the questions it couldn't answer"),
    inbox: z
      .object({
        ...rangeFields,
        daily: z
          .object({
            created: counts("New conversations", 8),
            fromAi: counts("New conversations started by “Ask a person” after an AI answer", 1),
          })
          .describe("Each count by day, one value for each of `days`"),
        totals: z
          .object({
            conversations: n("New conversations", 240),
            fromAi: n("Started by “Ask a person” after an AI answer", 60),
            replied: n("Of those, how many the team replied to", 230),
            medianFirstReply: z
              .number()
              .nullable()
              .describe("The median time to the team's first reply, in seconds, of those replied to; null with none")
              .meta({ examples: [2700] }),
            openNow: n("Conversations open now, whatever the range", 7),
          })
          .describe("The range's totals"),
        before: z
          .object({
            conversations: n("New conversations", 210.5),
            fromAi: n("Started by “Ask a person”", 52),
            medianFirstReply: z.number().nullable().describe("The median time to the first reply, in seconds; null with none").meta({ examples: [3100] }),
          })
          .nullable()
          .describe(`${BEFORE}. Null where some were deleted`),
        origins: z
          .object({
            widget: n("From the widget", 150),
            email: n("By email", 20),
            escalation: n("From “Ask a person”", 60),
            api: n("From the API", 10),
          })
          .describe("New conversations by where they began"),
        teammates: z
          .array(
            z.object({
              id: z.string().nullable().describe("The teammate's id; null for one who left").meta({ examples: ["cm3user0001"] }),
              name: z.string().nullable().describe("Their name").meta({ examples: ["Olive Owner"] }),
              replies: n("Their replies", 140),
              conversations: n("Conversations they replied in", 95),
            }),
          )
          .describe("Replies per teammate, most first"),
      })
      .describe("The inbox: new conversations by where they began, the median time to the team's first reply, open now, and replies per teammate"),
  })
  .describe("How the range went");

export const getReports = defineOperation({
  name: "reports.get",
  title: "Get reports",
  summary:
    "How the docs, their AI and the inbox did over a range of days: by day (UTC), in total, and over as many days just before. Failed searches and conversations list 50, comments and questions 20. Where plans are sold, needs a plan with Reporting, for ranges as long as that plan allows (402 otherwise).",
  method: "GET",
  path: "/reports",
  scope: "read",
  access: "team",
  errors: [402],
  // Unpicked: the default range, or the longest the plan has where that's locked (defaultRange).
  input: z.object({
    range: z
      .enum(RANGE_KEYS)
      .optional()
      .describe("Which days, in whole UTC days up to today: the past 30 days by default (or the longest the plan has, where that's locked)")
      .meta({ examples: ["7d"] }),
  }),
  output: reportsOutput,
  example: { range: "7d" },
  run: async ({ projectId }, input) => {
    const plan = await requirePlan(projectId, "reporting");
    const given = input.range ?? defaultRange(plan);
    if (lockedRanges(plan).includes(given)) {
      throw new OperationError(402, "plan_required", `${reportingRangeNeeded(plan)} See Settings → Billing.`);
    }
    const range = reportRange(given);
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
