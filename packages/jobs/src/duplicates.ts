import { prisma } from "@tuti/db";
import {
  contentHash,
  DUPLICATE_MIN_SIMILARITY,
  embed,
  EMBEDDING_MODEL,
  postEmbeddingText,
  toVectorLiteral,
} from "@tuti/shared";

import { meter } from "./ai-usage";

type PostText = { id: string; projectId: string; title: string; body: string };

/** Stores embeddings for posts whose text changed (or that have none). Returns how many were embedded. */
export async function embedPosts(posts: PostText[]): Promise<number> {
  if (posts.length === 0) {
    return 0;
  }
  const existing = await prisma.postEmbedding.findMany({
    where: { postId: { in: posts.map((p) => p.id) } },
    select: { postId: true, contentHash: true },
  });
  const hashes = new Map(existing.map((e) => [e.postId, e.contentHash]));
  const pending = posts
    .map((post) => ({ post, text: postEmbeddingText(post) }))
    .map((item) => ({ ...item, hash: contentHash(item.text) }))
    .filter((item) => hashes.get(item.post.id) !== item.hash);

  // A project's posts in their own requests, so each pays for its own.
  const byProject = new Map<string, typeof pending>();
  for (const item of pending) {
    const bucket = byProject.get(item.post.projectId);
    if (bucket) {
      bucket.push(item);
    } else {
      byProject.set(item.post.projectId, [item]);
    }
  }
  const batches = [...byProject.values()].flatMap((items) =>
    Array.from({ length: Math.ceil(items.length / 100) }, (_, i) => items.slice(i * 100, i * 100 + 100)),
  );
  for (const batch of batches) {
    const vectors = await embed(
      batch.map((item) => item.text),
      { meter: meter(batch[0]!.post.projectId, "duplicates") },
    );
    for (const [j, item] of batch.entries()) {
      const vector = toVectorLiteral(vectors[j]!);
      await prisma.$executeRaw`
        INSERT INTO post_embedding ("postId", "projectId", model, "contentHash", embedding, "updatedAt")
        VALUES (${item.post.id}, ${item.post.projectId}, ${EMBEDDING_MODEL}, ${item.hash}, ${vector}::vector, now())
        ON CONFLICT ("postId") DO UPDATE SET
          model = EXCLUDED.model, "contentHash" = EXCLUDED."contentHash",
          embedding = EXCLUDED.embedding, "updatedAt" = now()`;
    }
  }
  return pending.length;
}

/**
 * Suggests older posts in the same project that this post may duplicate.
 * Existing suggestions (including dismissed ones) are left as they are.
 * Returns how many new suggestions were added.
 */
export async function detectDuplicates(postId: string): Promise<number> {
  const matches = await prisma.$queryRaw<{ originalId: string; projectId: string; similarity: number }[]>`
    SELECT o."postId" AS "originalId", o."projectId", 1 - (o.embedding <=> e.embedding) AS similarity
    FROM post_embedding e
    JOIN post p ON p.id = e."postId"
    JOIN post_embedding o ON o."projectId" = e."projectId" AND o."postId" <> e."postId"
    JOIN post op ON op.id = o."postId"
    WHERE e."postId" = ${postId}
      AND p."duplicateOfId" IS NULL
      AND op."duplicateOfId" IS NULL
      AND op."createdAt" < p."createdAt"
    ORDER BY o.embedding <=> e.embedding
    LIMIT 3`;

  const likely = matches.filter((m) => m.similarity >= DUPLICATE_MIN_SIMILARITY);
  if (likely.length === 0) {
    return 0;
  }
  const { count } = await prisma.duplicateSuggestion.createMany({
    data: likely.map((m) => ({ projectId: m.projectId, postId, originalId: m.originalId, similarity: m.similarity })),
    skipDuplicates: true,
  });
  return count;
}
