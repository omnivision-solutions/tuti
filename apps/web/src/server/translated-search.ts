import { Prisma, prisma } from "@tuti/db";
import { embed, embeddingsEnabled, log, SEARCH_MIN_SIMILARITY, toVectorLiteral } from "@tuti/shared";
import { searchConfig } from "@tuti/shared/languages";

import type { Reader } from "@/lib/read-access";
import { visibleArticleSql } from "@/lib/reader-groups";

import { type DocsSearchResult, SEARCH_EMBED_TIMEOUT_MS, snippet } from "./docs-search";

/**
 * Search in one of the project's languages (docs/plan.md L7, "Search in every language"): its published translations of
 * listed, published articles `reader` may read, best first, each with a snippet. Words through the language's Postgres
 * stemmer ("Rechnung" finds "Rechnungen"), or, for Japanese, Korean and Chinese (no spaces between words), inside words
 * (`pg_trgm`'s index, as the Inbox's search); with embeddings set up, the translations' sections that mean the same
 * first (their chunks, @tuti/jobs embedTranslation). Searching and AI answers in the reader's language use it (L10).
 * The results carry the article's slug: a translation's own is L8's.
 */
export async function searchTranslatedDocs(
  projectId: string,
  language: string,
  query: string,
  limit: number,
  reader: Reader,
  { embedTimeoutMs = SEARCH_EMBED_TIMEOUT_MS, meaning = true, unlisted = false }: { embedTimeoutMs?: number; meaning?: boolean; unlisted?: boolean } = {},
): Promise<DocsSearchResult[]> {
  const found = Prisma.sql`t."projectId" = ${projectId} AND t.language = ${language} AND t."publishedAt" IS NOT NULL
    AND a."publishedAt" IS NOT NULL AND a."deletedAt" IS NULL AND a.sample = false
    AND ${unlisted ? Prisma.sql`a.listing IN ('EVERYWHERE', 'UNLISTED')` : Prisma.sql`a.listing = 'EVERYWHERE'`} AND ${visibleArticleSql(reader)}`;
  const [byMeaning, byWords] = await Promise.all([
    meaning && embeddingsEnabled() ? meaningMatches(projectId, language, query, limit, embedTimeoutMs, found) : [],
    wordMatches(projectId, language, query, limit, found),
  ]);
  const seen = new Set(byMeaning.map((result) => result.slug));
  return [...byMeaning, ...byWords.filter((result) => !seen.has(result.slug))].slice(0, limit);
}

/** The translations' sections closest in meaning (each article's closest), at least SEARCH_MIN_SIMILARITY alike. */
async function meaningMatches(projectId: string, language: string, query: string, limit: number, timeoutMs: number, found: Prisma.Sql): Promise<DocsSearchResult[]> {
  let vector: string;
  try {
    const [embedding] = await embed([query], AbortSignal.timeout(timeoutMs));
    vector = toVectorLiteral(embedding!);
  } catch (error) {
    log.warn("Embedding a translated docs search failed; matching words only", { error });
    return [];
  }
  // ponytail: scans the language's chunks in the project, as the source's search does; an HNSW index past ~100k chunks.
  const rows = await prisma.$queryRaw<{ slug: string; title: string; heading: string; text: string }[]>`
    SELECT a.slug, t.title, best.heading, best.text
    FROM (
      SELECT DISTINCT ON (c."translationId") c."translationId", c.heading, c.text, c.embedding <=> ${vector}::vector AS distance
      FROM article_translation_chunk c
      WHERE c."projectId" = ${projectId} AND c.language = ${language}
      ORDER BY c."translationId", distance, c.position
    ) best
    JOIN article_translation t ON t.id = best."translationId"
    JOIN article a ON a.id = t."articleId"
    WHERE ${found} AND best.distance <= ${1 - SEARCH_MIN_SIMILARITY}
    ORDER BY best.distance, t.title
    LIMIT ${limit}`;
  return rows.map(({ slug, title, heading, text }) => ({ slug, title, snippet: snippet(text || heading) }));
}

/** The most terms a search in Japanese, Korean or Chinese matches (each one a part of the query). */
const MAX_TERMS = 32;

/** A LIKE pattern's text, its wildcards taken literally. */
const likeText = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/** Matches by words: stemmed where the language has a stemmer, else (ja, ko, zh-CN) each of the query's terms inside words. */
async function wordMatches(projectId: string, language: string, query: string, limit: number, found: Prisma.Sql): Promise<DocsSearchResult[]> {
  const config = searchConfig(language);
  if (config) {
    // ponytail: each translation's tsvector per search, as the source's; a stored column with a GIN index if docs get big.
    const rows = await prisma.$queryRaw<{ slug: string; title: string; passage: string; description: string; inText: boolean }[]>`
      SELECT a.slug, t.title, t.description, to_tsvector(${config}::regconfig, t.body) @@ q AS "inText",
        ts_headline(${config}::regconfig, t.body, q, 'MaxWords=30, MinWords=15, ShortWord=2, StartSel="", StopSel=""') AS passage
      FROM article_translation t
      JOIN article a ON a.id = t."articleId"
      CROSS JOIN websearch_to_tsquery(${config}::regconfig, ${query}) q
      CROSS JOIN LATERAL (
        SELECT setweight(to_tsvector(${config}::regconfig, t.title), 'A')
          || setweight(to_tsvector(${config}::regconfig, array_to_string(t.keywords, ' ')), 'B')
          || to_tsvector(${config}::regconfig, t.body) AS words
      ) d
      WHERE ${found} AND d.words @@ q
      ORDER BY ts_rank(d.words, q) DESC, t.title
      LIMIT ${limit}`;
    return rows.map(({ slug, title, passage, description, inText }) => ({ slug, title, snippet: snippet(!inText && description ? description : passage) }));
  }
  // Written without spaces between words: each term the reader typed (split where they put spaces) found inside the text.
  // Every term counts; a query of more than MAX_TERMS is no search a reader types (nothing found, rather than matching
  // fewer terms than were asked for).
  const terms = [...new Set(query.split(/\s+/u).filter(Boolean))];
  if (terms.length === 0 || terms.length > MAX_TERMS) {
    return [];
  }
  // Each term's matches: in the body (a predicate of its own, which the body's trigram index can serve) or in the title or
  // keywords; a translation must match every term. The language's rows of the project are what's searched either way.
  // ponytail: the trigram index serves a term of three characters or more (shorter ones, often in these languages, read
  // the language's rows); a stored, indexed search text per row if docs get big.
  const inLanguage = Prisma.sql`"projectId" = ${projectId} AND language = ${language}`;
  const matching = (term: string) => {
    const pattern = `%${likeText(term)}%`;
    return Prisma.sql`(SELECT id FROM article_translation WHERE ${inLanguage} AND body ILIKE ${pattern}
      UNION SELECT id FROM article_translation WHERE ${inLanguage} AND (title ILIKE ${pattern} OR array_to_string(keywords, ' ') ILIKE ${pattern}))`;
  };
  const first = terms[0]!;
  const rows = await prisma.$queryRaw<{ slug: string; title: string; body: string; description: string; at: number }[]>`
    SELECT a.slug, t.title, t.body, t.description, strpos(lower(t.body), lower(${first})) AS at
    FROM article_translation t
    JOIN article a ON a.id = t."articleId"
    WHERE ${found} AND t.id IN (${Prisma.join(terms.map(matching), " INTERSECT ")})
    ORDER BY (t.title ILIKE ${`%${likeText(first)}%`}) DESC, t.title
    LIMIT ${limit}`;
  // The passage from a little before the first term, where the text has it; else the team's description.
  return rows.map(({ slug, title, body, description, at }) => ({
    slug,
    title,
    snippet: snippet(at > 0 ? `${at > 20 ? "…" : ""}${body.slice(Math.max(0, at - 21))}` : description || body),
  }));
}
