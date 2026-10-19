import { type Doc, fromPlainText, toChunks } from "@tuti/content";
import { prisma } from "@tuti/db";
import { articleChunkText, contentHash, embed, EMBEDDING_MODEL, embeddingsEnabled, type JobInput, toVectorLiteral } from "@tuti/shared";

import type { JobLogger, JobResult } from "./index";

const articleSelect = { projectId: true, title: true, body: true, content: true, publishedAt: true } as const;
type ArticleText = { projectId: string; title: string; body: string; content: unknown; publishedAt: Date | null };

/** What a published article's chunks should be, with their hash; null for a draft or a deleted article. */
function chunksOf(article: ArticleText | null) {
  if (!article?.publishedAt) {
    return null;
  }
  const chunks = toChunks((article.content as Doc | null) ?? fromPlainText(article.body)).map((chunk) => ({
    ...chunk,
    embedText: articleChunkText(article.title, chunk),
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
    log.info("OPENAI_API_KEY not set: help search matches words only");
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
