import { prisma } from "@tuti/db";
import { ANSWER_MIN_SIMILARITY, embed, embeddingsEnabled, log, SEARCH_MIN_SIMILARITY, toVectorLiteral } from "@tuti/shared";

export type HelpSearchResult = { slug: string; title: string; snippet: string };

const SNIPPET_LENGTH = 200;
/** How long a search waits for its query's embedding before it matches words only. */
const SEARCH_EMBED_TIMEOUT_MS = 2000;

/**
 * A project's published help articles that match a query, best first, each with a
 * snippet. With OPENAI_API_KEY set, articles with a section that means the same
 * (embeddings, see the articleChanged job) come first, with that section. Then come
 * articles that contain the query's words (Postgres full-text search), with the
 * passage around them: all there is without a key, and with one it still finds exact
 * terms, articles not embedded yet, and everything while OpenAI is down or slow.
 */
export async function searchHelp(
  projectId: string,
  query: string,
  limit: number,
  embedTimeoutMs = SEARCH_EMBED_TIMEOUT_MS,
): Promise<HelpSearchResult[]> {
  const [byMeaning, byWords] = await Promise.all([
    embeddingsEnabled() ? meaningMatches(projectId, query, limit, embedTimeoutMs) : [],
    wordMatches(projectId, query, limit),
  ]);
  const found = new Set(byMeaning.map((result) => result.slug));
  const results = [...byMeaning, ...byWords.filter((result) => !found.has(result.slug))].slice(0, limit);
  logSearch(projectId, query, results.length);
  return results;
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
  prisma.helpSearch
    .create({ data: { projectId, query: normalized, results } })
    .catch((error: unknown) => log.warn("Logging a help search failed", { projectId, error }));
}

async function meaningMatches(projectId: string, query: string, limit: number, timeoutMs: number): Promise<HelpSearchResult[]> {
  let vector: string;
  try {
    const [embedding] = await embed([query], AbortSignal.timeout(timeoutMs));
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a help search failed; matching words only", { error });
    return [];
  }
  // Each article's closest section, then the articles by how close it is.
  // ponytail: scans all of the project's chunks; fine for help centers, add an HNSW index past ~100k chunks.
  const rows = await prisma.$queryRaw<{ slug: string; title: string; heading: string; text: string }[]>`
    SELECT a.slug, a.title, best.heading, best.text
    FROM (
      SELECT DISTINCT ON (c."articleId") c."articleId", c.heading, c.text, c.embedding <=> ${vector}::vector AS distance
      FROM article_chunk c
      WHERE c."projectId" = ${projectId}
      ORDER BY c."articleId", distance, c.position
    ) best
    JOIN article a ON a.id = best."articleId"
    WHERE a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND best.distance <= ${1 - SEARCH_MIN_SIMILARITY}
    ORDER BY best.distance, a.title
    LIMIT ${limit}`;
  return rows.map(({ slug, title, heading, text }) => ({ slug, title, snippet: snippet(text || heading) }));
}

export type AnswerSection = { articleId: string; slug: string; title: string; heading: string; text: string };

/**
 * The published sections closest to a question, at least ANSWER_MIN_SIMILARITY alike, best
 * first: what AI answers may use (help.ask). Null if the question couldn't be embedded in time.
 */
export async function answerSections(projectId: string, question: string, limit: number, timeoutMs: number): Promise<AnswerSection[] | null> {
  let vector: string;
  try {
    const [embedding] = await embed([question], AbortSignal.timeout(timeoutMs));
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a help question failed", { projectId, error });
    return null;
  }
  // ponytail: scans all of the project's chunks, like meaningMatches.
  return prisma.$queryRaw<AnswerSection[]>`
    SELECT a.id AS "articleId", a.slug, a.title, c.heading, c.text
    FROM article_chunk c
    JOIN article a ON a.id = c."articleId"
    WHERE c."projectId" = ${projectId} AND a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL
      AND c.embedding <=> ${vector}::vector <= ${1 - ANSWER_MIN_SIMILARITY}
    ORDER BY c.embedding <=> ${vector}::vector, a.title, c.position
    LIMIT ${limit}`;
}

// ponytail: computes each article's tsvector per search; add a stored column with a GIN index if help centers get big.
async function wordMatches(projectId: string, query: string, limit: number): Promise<HelpSearchResult[]> {
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
    WHERE a."projectId" = ${projectId} AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND d.words @@ q
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
