import { type Doc, fromPlainText, toChunks } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import { articleChunkText, contentHash, embed, EMBEDDING_MODEL, embeddingsEnabled, type JobInput, toVectorLiteral } from "@tuti/shared";

import type { JobLogger, JobResult } from "./index";

const articleSelect = { projectId: true, title: true, body: true, content: true, keywords: true, publishedAt: true } as const;
type ArticleText = { projectId: string; title: string; body: string; content: unknown; keywords: string[]; publishedAt: Date | null };

/** What a published article's chunks should be, with their hash; null for a draft or a deleted article. */
function chunksOf(article: ArticleText | null) {
  if (!article?.publishedAt) {
    return null;
  }
  // Its keywords go with its first section: words readers use that the text doesn't.
  const chunks = toChunks((article.content as Doc | null) ?? fromPlainText(article.body)).map((chunk, i) => ({
    ...chunk,
    embedText: articleChunkText(article.title, chunk, i === 0 ? article.keywords : []),
  }));
  return { projectId: article.projectId, chunks, hash: contentHash(chunks.map((c) => c.embedText).join("\n\u0000\n")) };
}

/**
 * Removes article `articleId`'s sections and its vector (article_vector) together, so search, AI
 * answers and related articles stop using it at once: every removal goes through here.
 */
export async function removeArticleSections(db: Pick<Prisma.TransactionClient, "articleChunk" | "articleVector">, articleId: string) {
  await db.articleChunk.deleteMany({ where: { articleId } });
  await db.articleVector.deleteMany({ where: { articleId } });
}

/**
 * Makes articles' vectors for related articles (article_vector) match their sections: the average
 * of their embeddings, written where it's missing or was made from other sections (their
 * contentHash differs), and removed where no sections are left; the rest are left alone. For
 * `articleId`, or every article: once when the worker starts, for what the previous release's
 * worker embedded during a deploy (it writes sections, not vectors).
 */
export async function fillArticleVectors(db: Pick<typeof prisma, "$executeRaw">, articleId?: string) {
  const only = (column: Prisma.Sql) => (articleId ? Prisma.sql`AND ${column} = ${articleId}` : Prisma.empty);
  await db.$executeRaw`
    INSERT INTO article_vector ("articleId", "contentHash", embedding)
    SELECT c."articleId", min(c."contentHash"), avg(c.embedding)
    FROM article_chunk c
    LEFT JOIN article_vector v ON v."articleId" = c."articleId"
    WHERE (v."articleId" IS NULL OR v."contentHash" <> c."contentHash") ${only(Prisma.sql`c."articleId"`)}
    GROUP BY c."articleId"
    ON CONFLICT ("articleId") DO UPDATE SET "contentHash" = EXCLUDED."contentHash", embedding = EXCLUDED.embedding`;
  await db.$executeRaw`
    DELETE FROM article_vector v
    WHERE NOT EXISTS (SELECT 1 FROM article_chunk c WHERE c."articleId" = v."articleId") ${only(Prisma.sql`v."articleId"`)}`;
}

/**
 * Embeds a published article's sections for search, replacing its old chunks, or
 * removes them once it's unpublished or deleted. Safe to run late, twice or out of
 * order: chunks are only written while the article still has the text they came from.
 */
export async function articleChanged({ articleId }: JobInput<"articleChanged">, log: JobLogger): Promise<JobResult> {
  if (!embeddingsEnabled()) {
    log.info("OPENAI_API_KEY not set: docs search matches words only");
    return { skipped: true };
  }
  const next = chunksOf(await prisma.article.findUnique({ where: { id: articleId }, select: articleSelect }));
  if (next) {
    const stored = await prisma.articleChunk.findFirst({ where: { articleId }, select: { contentHash: true } });
    if (stored?.contentHash === next.hash) {
      // Its sections are current; its vector may not be (embedded by the previous release's worker).
      await fillArticleVectors(prisma, articleId);
      return { skipped: false, embedded: 0 };
    }
  }
  const vectors = next ? await embed(next.chunks.map((c) => c.embedText)) : [];

  const written = await prisma.$transaction(async (tx) => {
    // Locked, so a save, unpublish or delete can't slip in between this check and the write.
    await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${articleId} FOR UPDATE`;
    const latest = chunksOf(await tx.article.findUnique({ where: { id: articleId }, select: articleSelect }));
    if (latest?.hash !== next?.hash) {
      return false;
    }
    await removeArticleSections(tx, articleId);
    for (const [position, chunk] of (next?.chunks ?? []).entries()) {
      await tx.$executeRaw`
        INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
        VALUES (gen_random_uuid()::text, ${articleId}, ${next!.projectId}, ${position}, ${chunk.heading}, ${chunk.text},
          ${EMBEDDING_MODEL}, ${next!.hash}, ${toVectorLiteral(vectors[position]!)}::vector)`;
    }
    await fillArticleVectors(tx, articleId);
    return true;
  });
  if (!written) {
    // The job queued by that change writes the newer chunks.
    log.info(`article ${articleId} changed while it was being embedded; left to the newer job`);
    return { skipped: true };
  }
  return { skipped: false, embedded: next?.chunks.length ?? 0 };
}

/** For the backfill: embeds every published article (unchanged ones are skipped), carrying on past failures. */
export async function embedPublishedArticles(log: JobLogger): Promise<{ articles: number; embedded: number; failed: string[] }> {
  const articles = await prisma.article.findMany({
    where: { publishedAt: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const failed: string[] = [];
  let embedded = 0;
  for (const { id } of articles) {
    try {
      const result = await articleChanged({ articleId: id }, log);
      if (Number(result.embedded) > 0) {
        embedded++;
      }
    } catch (error) {
      log.warn(`article ${id} wasn't embedded: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(id);
    }
  }
  return { articles: articles.length, embedded, failed };
}

/** How long a deleted article can be restored; then `purgeArticles` removes it for good. */
export const DELETED_ARTICLE_DAYS = 30;

/**
 * Removes articles deleted more than DELETED_ARTICLE_DAYS ago, with their revisions, feedback and
 * views; `releaseMedia` then frees the uploads only they used. A restore racing this wins or
 * loses cleanly: Postgres re-checks `deletedAt` on a row restored while the delete waited for it.
 */
export async function purgeArticles(_input: JobInput<"purgeArticles">, log: JobLogger): Promise<JobResult> {
  const cutoff = new Date(Date.now() - DELETED_ARTICLE_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.article.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  log.info(`purged ${count} article(s) deleted more than ${DELETED_ARTICLE_DAYS} days ago`);
  return { purged: count };
}
