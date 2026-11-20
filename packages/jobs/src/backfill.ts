import { prisma } from "@tuti/db";
import { embeddingsEnabled } from "@tuti/shared";

import { indexApiReferences } from "./api-references";
import { embedPublishedArticles } from "./articles";
import type { JobLogger } from "./index";
import { detectDuplicates, embedPosts } from "./duplicates";

/**
 * The embeddings backfill (the worker's backfill:embeddings): embeds existing posts and suggests duplicates for those
 * embedded for the first time,
 * and embeds published docs articles for search, when embeddings are set up; then indexes every API reference's
 * operations for the docs' search and AI answers, set up or not (their word search needs it either way). Each phase runs
 * whatever happened in the one before: a failure (the embeddings provider down, say) is kept in `errors`, by phase, for
 * the script to report and fail on, and stops nothing after it.
 */
export async function backfillEmbeddings(log: JobLogger) {
  let posts = null;
  let articles = null;
  const errors: { phase: "posts" | "articles" | "references"; message: string }[] = [];
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (embeddingsEnabled()) {
    try {
      const rows = await prisma.post.findMany({
        // Never sample content (Home's "Add sample content"): it's never embedded or suggested as a duplicate.
        where: { duplicateOfId: null, sample: false },
        orderBy: { createdAt: "asc" },
        select: { id: true, projectId: true, title: true, body: true, createdAt: true },
      });
      // Posts embedded before were checked for duplicates when they were (each check is a charged model request): only
      // the others are checked, against every older post. A post embedded before but newer than one of them never saw
      // it (a post is compared with older ones): it's checked against those alone. A rerun asks nothing again.
      const before = new Set((await prisma.postEmbedding.findMany({ select: { postId: true } })).map((e) => e.postId));
      const fresh = new Map<string, { id: string; createdAt: Date }[]>();
      for (const row of rows.filter((row) => !before.has(row.id))) {
        fresh.set(row.projectId, [...(fresh.get(row.projectId) ?? []), row]);
      }
      // Embed everything first, then compare, so every post sees all older ones.
      const embedded = await embedPosts(rows);
      let suggestions = 0;
      let failed: unknown = null;
      for (const post of rows) {
        const older = (fresh.get(post.projectId) ?? []).filter((row) => row.createdAt < post.createdAt).map((row) => row.id);
        if (before.has(post.id) && older.length === 0) {
          continue;
        }
        try {
          suggestions += await detectDuplicates(post.id, before.has(post.id) ? older : undefined);
        } catch (error) {
          // One this run embedded is unembedded again, so the next run checks it; the rest carry on.
          if (!before.has(post.id)) {
            await prisma.postEmbedding.deleteMany({ where: { postId: post.id } });
          }
          failed ??= error;
        }
      }
      if (failed) {
        throw failed;
      }
      posts = { posts: rows.length, embedded, suggestions };
    } catch (error) {
      errors.push({ phase: "posts", message: message(error) });
    }
    try {
      // Published docs articles, for search (unchanged ones are skipped).
      articles = await embedPublishedArticles(log);
    } catch (error) {
      errors.push({ phase: "articles", message: message(error) });
    }
  }
  let references = null;
  try {
    // API references' operations (references added before they were indexed, too).
    references = await indexApiReferences(log);
  } catch (error) {
    errors.push({ phase: "references", message: message(error) });
  }
  return { posts, articles, references, errors };
}
