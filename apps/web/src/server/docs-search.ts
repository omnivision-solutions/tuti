import { type ArticleListing, Prisma, prisma } from "@tuti/db";
import { FAILED_SEARCHES_PER_DAY } from "@tuti/jobs";
import { ANSWER_MIN_SIMILARITY, embed, embeddingsEnabled, log, SEARCH_MIN_SIMILARITY, toVectorLiteral } from "@tuti/shared";

import type { Reader } from "@/lib/read-access";
import { visibleArticleSql } from "@/lib/reader-groups";

import { docsContents, everyCollection } from "./docs-queries";
import { currentReader } from "./portal-access";

/** `locked`: an article this reader may not read, found by its title alone (no snippet). */
export type DocsSearchResult = { slug: string; title: string; snippet: string; locked?: true };

const SNIPPET_LENGTH = 200;
/** How long a search waits for its query's embedding before it matches words only. */
const SEARCH_EMBED_TIMEOUT_MS = 2000;

/** How a search runs: how long it waits for the embedding, whether it's counted in the team's insights, and whether it matches by meaning at all. */
export type SearchOptions = { embedTimeoutMs?: number; log?: boolean; meaning?: boolean };

/**
 * A project's listed docs articles (published, listed everywhere) that match a query, best first, each with a
 * snippet. With OPENAI_API_KEY set, articles with a section that means the same
 * (embeddings, see the articleChanged job) come first, with that section. Then come
 * articles that contain the query's words (Postgres full-text search), with the
 * passage around them: all there is without a key, and with one it still finds exact
 * terms, articles not embedded yet, and everything while OpenAI is down or slow.
 * Only articles `reader` may read (null: the team, everything).
 */
export async function searchDocs(
  projectId: string,
  query: string,
  limit: number,
  reader: Reader,
  { embedTimeoutMs = SEARCH_EMBED_TIMEOUT_MS, log = true, meaning = true }: SearchOptions = {},
): Promise<DocsSearchResult[]> {
  const [byMeaning, byWords] = await Promise.all([
    meaning && embeddingsEnabled() ? meaningMatches(projectId, query, limit, reader, embedTimeoutMs) : [],
    wordMatches(projectId, query, limit, reader),
  ]);
  const found = new Set(byMeaning.map((result) => result.slug));
  const results = [...byMeaning, ...byWords.filter((result) => !found.has(result.slug))].slice(0, limit);
  if (log) {
    logSearch(projectId, query, results.length);
  }
  return results;
}

/**
 * Search on the portal and in the widget, for whoever's reading: what they may read (searchDocs),
 * then the articles listed to them with a lock (see docsContents) whose titles match. Those are
 * matched by their title alone and come without a snippet, so nothing of what they say is searched or shown.
 */
export async function searchForReader(
  projectId: string,
  projectSlug: string,
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<DocsSearchResult[]> {
  const [results, docs] = await Promise.all([searchDocs(projectId, query, limit, await currentReader(projectId), options), docsContents(projectSlug)]);
  const locked = [...everyCollection(docs.collections).flatMap((c) => c.articles), ...docs.uncollected].filter((a) => a.locked).map((a) => a.slug);
  if (locked.length === 0 || results.length >= limit) {
    return results;
  }
  const byTitle = await prisma.$queryRaw<{ slug: string; title: string }[]>`
    SELECT a.slug, a.title
    FROM article a
    CROSS JOIN websearch_to_tsquery('english', ${query}) q
    CROSS JOIN to_tsquery('simple', ${prefixQuery(query)}::text) pq
    WHERE a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.listing = 'EVERYWHERE'
      AND a.slug = ANY(${locked}::text[])
      -- Whole words, or the start of each word as typed, like wordMatches.
      AND (to_tsvector('english', a.title) @@ q OR coalesce(to_tsvector('simple', a.title) @@ pq, false))
    ORDER BY ts_rank(to_tsvector('english', a.title), q) + coalesce(ts_rank(to_tsvector('simple', a.title), pq), 0) DESC, a.title
    LIMIT ${limit - results.length}`;
  return [...results, ...byTitle.map(({ slug, title }) => ({ slug, title, snippet: "", locked: true as const }))];
}

/** A query as the team's insights count it: trimmed, one space between words, lower case. */
const normalizeQuery = (query: string) => query.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);

/**
 * Counts a search in the team's insights (no results is a failed search): the day's counters,
 * and for a failed search its words with how often, up to FAILED_SEARCHES_PER_DAY different ones
 * a day (more still count, without their words). A search that found something keeps no words.
 * Not awaited and never throws, so logging can't slow search down or break it.
 */
export function logSearch(projectId: string, query: string, results: number) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return;
  }
  const failed = results === 0;
  // Both under one now(): the transaction's, so a search near midnight counts on one day.
  const today = Prisma.sql`(now() AT TIME ZONE 'UTC')::date`;
  prisma
    .$transaction([
      prisma.$executeRaw`
        INSERT INTO docs_search_day ("projectId", day, searches, failed)
        VALUES (${projectId}, ${today}, 1, ${failed ? 1 : 0}::int)
        ON CONFLICT ("projectId", day) DO UPDATE SET searches = docs_search_day.searches + 1, failed = docs_search_day.failed + EXCLUDED.failed`,
      ...(failed
        ? [
            // Counted if it's kept already; else kept while the day has room (a few over under concurrency).
            prisma.$executeRaw`
              WITH bumped AS (
                UPDATE docs_failed_search_day SET count = count + 1
                WHERE "projectId" = ${projectId} AND day = ${today} AND query = ${normalized}
                RETURNING 1
              )
              INSERT INTO docs_failed_search_day ("projectId", day, query, count)
              SELECT ${projectId}, ${today}, ${normalized}, 1
              WHERE NOT EXISTS (SELECT 1 FROM bumped)
                AND (SELECT count(*) FROM docs_failed_search_day WHERE "projectId" = ${projectId} AND day = ${today}) < ${FAILED_SEARCHES_PER_DAY}
              ON CONFLICT ("projectId", day, query) DO UPDATE SET count = docs_failed_search_day.count + 1`,
          ]
        : []),
    ])
    .catch((error: unknown) => log.warn("Logging a docs search failed", { projectId, error }));
}

async function meaningMatches(projectId: string, query: string, limit: number, reader: Reader, timeoutMs: number): Promise<DocsSearchResult[]> {
  let vector: string;
  try {
    const [embedding] = await embed([query], AbortSignal.timeout(timeoutMs));
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a docs search failed; matching words only", { error });
    return [];
  }
  // Each article's closest section, then the articles by how close it is.
  // ponytail: scans all of the project's chunks; fine for docs, add an HNSW index past ~100k chunks.
  const rows = await prisma.$queryRaw<{ slug: string; title: string; heading: string; text: string }[]>`
    SELECT a.slug, a.title, best.heading, best.text
    FROM (
      SELECT DISTINCT ON (c."articleId") c."articleId", c.heading, c.text, c.embedding <=> ${vector}::vector AS distance
      FROM article_chunk c
      WHERE c."projectId" = ${projectId}
      ORDER BY c."articleId", distance, c.position
    ) best
    JOIN article a ON a.id = best."articleId"
    WHERE a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.listing = 'EVERYWHERE' AND best.distance <= ${1 - SEARCH_MIN_SIMILARITY}
      AND ${visibleArticleSql(reader)}
    ORDER BY best.distance, a.title
    LIMIT ${limit}`;
  return rows.map(({ slug, title, heading, text }) => ({ slug, title, snippet: snippet(text || heading) }));
}

export type AnswerSection = { articleId: string; slug: string; title: string; listing: ArticleListing; heading: string; text: string };

/**
 * The published sections closest to a question, at least ANSWER_MIN_SIMILARITY alike, best
 * first: what AI answers may use (docs.ask). Every listing but hidden: unlisted articles are
 * public at their link anyway, and AI-only ones are there for this. Only articles the asker,
 * `reader` may read. Null if the question couldn't be embedded in time.
 */
export async function answerSections(
  projectId: string,
  question: string,
  limit: number,
  reader: Reader,
  timeoutMs: number,
): Promise<AnswerSection[] | null> {
  let vector: string;
  try {
    const [embedding] = await embed([question], AbortSignal.timeout(timeoutMs));
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a docs question failed", { projectId, error });
    return null;
  }
  // ponytail: scans all of the project's chunks, like meaningMatches.
  return prisma.$queryRaw<AnswerSection[]>`
    SELECT a.id AS "articleId", a.slug, a.title, a.listing, c.heading, c.text
    FROM article_chunk c
    JOIN article a ON a.id = c."articleId"
    WHERE c."projectId" = ${projectId} AND a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
      AND a.listing <> 'HIDDEN' AND ${visibleArticleSql(reader)}
      AND c.embedding <=> ${vector}::vector <= ${1 - ANSWER_MIN_SIMILARITY}
    ORDER BY c.embedding <=> ${vector}::vector, a.title, c.position
    LIMIT ${limit}`;
}

/** The most words a prefix query takes: a longer query is someone pasting, not typing. */
const MAX_PREFIX_WORDS = 8;

/**
 * The query's words as a prefix query for Postgres ("sig in" → `sig:* & in:*`), so a word still
 * being typed matches the words it starts ("sig" finds "signing"). Null without any words, past 8,
 * or with web search's operators (a quoted phrase, `-word`, `or`): it would match more than they say,
 * so those queries match whole words only.
 */
export function prefixQuery(query: string): string | null {
  const lower = query.toLowerCase();
  if (/"|(^|\s)-\S|(^|\s)or(\s|$)/u.test(lower)) {
    return null;
  }
  const words = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.length <= MAX_PREFIX_WORDS ? words.map((word) => `${word}:*`).join(" & ") : null;
}

// ponytail: computes each article's tsvector per search; add a stored column with a GIN index if docs get big.
async function wordMatches(projectId: string, query: string, limit: number, reader: Reader): Promise<DocsSearchResult[]> {
  // The passage is a piece of the text; "…" marks where it was cut. Its title and keywords match too
  // (keywords: words readers use that the text doesn't); when the text doesn't, the team's description stands in for it.
  // Whole words (stemmed: "invites" finds "invite"), or the start of each word as typed, unstemmed (`prefixQuery`).
  const rows = await prisma.$queryRaw<
    { slug: string; title: string; passage: string; cutStart: boolean; cutEnd: boolean; description: string; inText: boolean }[]
  >`
    SELECT a.slug, a.title, h.passage, a.description, t."inText",
      left(a.body, length(h.passage)) <> h.passage AS "cutStart",
      right(a.body, length(h.passage)) <> h.passage AS "cutEnd"
    FROM article a
    CROSS JOIN websearch_to_tsquery('english', ${query}) q
    CROSS JOIN to_tsquery('simple', ${prefixQuery(query)}::text) pq
    CROSS JOIN LATERAL (
      SELECT setweight(to_tsvector('english', a.title), 'A') || setweight(to_tsvector('english', coalesce(array_to_string(a.keywords, ' '), '')), 'B')
        || to_tsvector('english', a.body) AS words,
        setweight(to_tsvector('simple', a.title), 'A') || setweight(to_tsvector('simple', coalesce(array_to_string(a.keywords, ' '), '')), 'B')
        || to_tsvector('simple', a.body) AS starts
    ) d
    CROSS JOIN LATERAL (
      SELECT to_tsvector('english', a.body) @@ q AS "whole", coalesce(to_tsvector('simple', a.body) @@ pq, false) AS "started"
    ) b
    CROSS JOIN LATERAL (SELECT b.whole OR b.started AS "inText") t
    CROSS JOIN LATERAL (
      SELECT CASE WHEN b.whole OR NOT b.started
        THEN ts_headline('english', a.body, q, 'MaxWords=30, MinWords=15, ShortWord=2, StartSel="", StopSel=""')
        ELSE ts_headline('simple', a.body, pq, 'MaxWords=30, MinWords=15, ShortWord=2, StartSel="", StopSel=""')
      END AS passage
    ) h
    WHERE a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.listing = 'EVERYWHERE'
      AND (d.words @@ q OR coalesce(d.starts @@ pq, false))
      AND ${visibleArticleSql(reader)}
    ORDER BY ts_rank(d.words, q) + coalesce(ts_rank(d.starts, pq), 0) DESC, a.title
    LIMIT ${limit}`;
  return rows.map(({ slug, title, passage, cutStart, cutEnd, description, inText }) => ({
    slug,
    title,
    snippet: snippet(!inText && description ? description : `${cutStart ? "…" : ""}${passage.trim()}${cutEnd ? "…" : ""}`),
  }));
}

/** On one line, cut at a word near SNIPPET_LENGTH. */
function snippet(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= SNIPPET_LENGTH) {
    return line;
  }
  const cut = line.lastIndexOf(" ", SNIPPET_LENGTH);
  return `${line.slice(0, cut > 0 ? cut : SNIPPET_LENGTH)}…`;
}
