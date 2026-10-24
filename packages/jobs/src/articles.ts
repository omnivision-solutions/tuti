import { type Doc, fromPlainText, toChunks } from "@tuti/content";
import { prisma } from "@tuti/db";
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
    await tx.articleChunk.deleteMany({ where: { articleId } });
    for (const [position, chunk] of (next?.chunks ?? []).entries()) {
      await tx.$executeRaw`
        INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
        VALUES (gen_random_uuid()::text, ${articleId}, ${next!.projectId}, ${position}, ${chunk.heading}, ${chunk.text},
          ${EMBEDDING_MODEL}, ${next!.hash}, ${toVectorLiteral(vectors[position]!)}::vector)`;
    }
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
