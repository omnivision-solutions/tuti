import { Prisma, prisma } from "@tuti/db";
import {
  contentHash,
  DUPLICATE_CANDIDATE_MIN_SIMILARITY,
  DUPLICATE_MIN_SIMILARITY,
  duplicatesModel,
  duplicateText,
  embed,
  EMBEDDING_MODEL,
  judgeDuplicates,
  log,
  postEmbeddingText,
  toVectorLiteral,
} from "@tuti/shared";

import { duplicatesMeter } from "./ai-usage";

type PostText = { id: string; projectId: string; title: string; body: string };

/**
 * Stores embeddings for posts whose text changed (or that have none), never for sample content (Home's "Add sample
 * content": no AI usage, and no embedding means duplicate detection never matches it). Returns how many were embedded.
 */
export async function embedPosts(posts: PostText[]): Promise<number> {
  if (posts.length === 0) {
    return 0;
  }
  const [existing, samples] = await Promise.all([
    prisma.postEmbedding.findMany({ where: { postId: { in: posts.map((p) => p.id) } }, select: { postId: true, contentHash: true } }),
    prisma.post.findMany({ where: { id: { in: posts.map((p) => p.id) }, sample: true }, select: { id: true } }),
  ]);
  const hashes = new Map(existing.map((e) => [e.postId, e.contentHash]));
  const sample = new Set(samples.map((p) => p.id));
  const pending = posts
    .filter((post) => !sample.has(post.id))
    .map((post) => ({ post, text: postEmbeddingText(post) }))
    .map((item) => ({ ...item, hash: contentHash(item.text) }))
    .filter((item) => hashes.get(item.post.id) !== item.hash);

  for (let i = 0; i < pending.length; i += 100) {
    const batch = pending.slice(i, i + 100);
    const vectors = await embed(batch.map((item) => item.text));
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
 * Suggests older posts in the same project that this post may duplicate: the 8 most similar by embedding, those the
 * decision model (the config file's `duplicates.posted.model`) calls duplicates. Without one, out of AI credits, or when it fails, the 3 most similar at
 * DUPLICATE_MIN_SIMILARITY or above. Existing suggestions (including dismissed ones) are left as they are. With `among`,
 * only those posts are candidates (the backfill, checking a post again against posts it has just checked). Once done,
 * the post is marked checked (`duplicatesCheckedAt`); a post without an embedding yet isn't checked, or marked.
 * Returns how many new suggestions were added.
 */
export async function detectDuplicates(postId: string, among?: string[]): Promise<number> {
  const [project, embedding] = await Promise.all([
    prisma.post.findUnique({ where: { id: postId }, select: { projectId: true } }),
    prisma.postEmbedding.findUnique({ where: { postId }, select: { postId: true } }),
  ]);
  if (!project || !embedding) {
    return 0;
  }
  // The model only while the project has AI credits (with credits on): out of them, similarity alone.
  const configured = duplicatesModel("posted");
  const meter = configured ? await duplicatesMeter(project.projectId) : null;
  const model = meter ? configured : null;
  const matches = await prisma.$queryRaw<{ originalId: string; projectId: string; similarity: number; title: string; body: string; postTitle: string; postBody: string }[]>`
    SELECT o."postId" AS "originalId", o."projectId", 1 - (o.embedding <=> e.embedding) AS similarity,
      op.title, op.body, p.title AS "postTitle", p.body AS "postBody"
    FROM post_embedding e
    JOIN post p ON p.id = e."postId"
    JOIN post_embedding o ON o."projectId" = e."projectId" AND o."postId" <> e."postId"
    JOIN post op ON op.id = o."postId"
    WHERE e."postId" = ${postId}
      AND p."duplicateOfId" IS NULL
      AND op."duplicateOfId" IS NULL
      AND op."createdAt" < p."createdAt"
      ${among ? Prisma.sql`AND o."postId" = ANY(${among})` : Prisma.empty}
    ORDER BY o.embedding <=> e.embedding
    LIMIT ${model ? 8 : 3}`;

  let likely = matches.filter((m) => m.similarity >= (model ? DUPLICATE_CANDIDATE_MIN_SIMILARITY : DUPLICATE_MIN_SIMILARITY));
  if (model && likely.length > 0) {
    try {
      const verdicts = await judgeDuplicates(model, duplicateText({ title: likely[0]!.postTitle, body: likely[0]!.postBody }), likely.map(duplicateText), 30_000, meter!);
      likely = likely.filter((_, k) => verdicts[k]!.verdict === "duplicate");
    } catch (error) {
      log.warn("Judging possible duplicates failed; suggesting by similarity alone", { postId, error });
      likely = likely.slice(0, 3).filter((m) => m.similarity >= DUPLICATE_MIN_SIMILARITY);
    }
  }
  const { count } =
    likely.length === 0
      ? { count: 0 }
      : await prisma.duplicateSuggestion.createMany({
          data: likely.map((m) => ({ projectId: m.projectId, postId, originalId: m.originalId, similarity: m.similarity })),
          skipDuplicates: true,
        });
  // updateMany: a post deleted meanwhile has nothing to mark.
  await prisma.post.updateMany({ where: { id: postId }, data: { duplicatesCheckedAt: new Date() } });
  return count;
}
