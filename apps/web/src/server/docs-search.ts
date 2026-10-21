import { type ArticleListing, prisma } from "@tuti/db";
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
  embedTimeoutMs = SEARCH_EMBED_TIMEOUT_MS,
): Promise<DocsSearchResult[]> {
  const [byMeaning, byWords] = await Promise.all([
    embeddingsEnabled() ? meaningMatches(projectId, query, limit, reader, embedTimeoutMs) : [],
    wordMatches(projectId, query, limit, reader),
  ]);
  const found = new Set(byMeaning.map((result) => result.slug));
  const results = [...byMeaning, ...byWords.filter((result) => !found.has(result.slug))].slice(0, limit);
  logSearch(projectId, query, results.length);
  return results;
}

/**
 * Search on the portal and in the widget, for whoever's reading: what they may read (searchDocs),
 * then the articles listed to them with a lock (see docsContents) whose titles match. Those are
 * matched by their title alone and come without a snippet, so nothing of what they say is searched or shown.
 */
export async function searchForReader(projectId: string, projectSlug: string, query: string, limit: number): Promise<DocsSearchResult[]> {
  const [results, docs] = await Promise.all([searchDocs(projectId, query, limit, await currentReader(projectId)), docsContents(projectSlug)]);
  const locked = [...everyCollection(docs.collections).flatMap((c) => c.articles), ...docs.uncollected].filter((a) => a.locked).map((a) => a.slug);
  if (locked.length === 0 || results.length >= limit) {
    return results;
  }
  const byTitle = await prisma.$queryRaw<{ slug: string; title: string }[]>`
    SELECT a.slug, a.title
    FROM article a
    CROSS JOIN websearch_to_tsquery('english', ${query}) q
    WHERE a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.listing = 'EVERYWHERE'
      AND a.slug = ANY(${locked}::text[]) AND to_tsvector('english', a.title) @@ q
    ORDER BY ts_rank(to_tsvector('english', a.title), q) DESC, a.title
    LIMIT ${limit - results.length}`;
  return [...results, ...byTitle.map(({ slug, title }) => ({ slug, title, snippet: "", locked: true as const }))];
}

/** A query as the team's insights count it: trimmed, one space between words, lower case. */
const normalizeQuery = (query: string) => query.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);

/**
 * Records a search for the team's insights (no results is a failed search). Not awaited
 * and never throws, so logging can't slow search down or break it.
 */
function logSearch(projectId: string, query: string, results: number) {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return;
  }
  prisma.docsSearch
    .create({ data: { projectId, query: normalized, results } })
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

// ponytail: computes each article's tsvector per search; add a stored column with a GIN index if docs get big.
async function wordMatches(projectId: string, query: string, limit: number, reader: Reader): Promise<DocsSearchResult[]> {
  // The passage is a piece of the text; "…" marks where it was cut.
  const rows = await prisma.$queryRaw<{ slug: string; title: string; passage: string; cutStart: boolean; cutEnd: boolean }[]>`
    SELECT a.slug, a.title, h.passage,
      left(a.body, length(h.passage)) <> h.passage AS "cutStart",
      right(a.body, length(h.passage)) <> h.passage AS "cutEnd"
    FROM article a
    CROSS JOIN websearch_to_tsquery('english', ${query}) q
    CROSS JOIN LATERAL (SELECT setweight(to_tsvector('english', a.title), 'A') || to_tsvector('english', a.body) AS words) d
    CROSS JOIN LATERAL (
      SELECT ts_headline('english', a.body, q, 'MaxWords=30, MinWords=15, ShortWord=2, StartSel="", StopSel=""') AS passage
    ) h
    WHERE a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.listing = 'EVERYWHERE' AND d.words @@ q
      AND ${visibleArticleSql(reader)}
    ORDER BY ts_rank(d.words, q) DESC, a.title
    LIMIT ${limit}`;
  return rows.map(({ slug, title, passage, cutStart, cutEnd }) => ({
    slug,
    title,
    snippet: snippet(`${cutStart ? "…" : ""}${passage.trim()}${cutEnd ? "…" : ""}`),
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
