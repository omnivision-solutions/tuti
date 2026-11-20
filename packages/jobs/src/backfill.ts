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
export async function backfillEmbeddings(log: JobLogger, { batchSize = 100 }: { batchSize?: number } = {}) {
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
      // Posts embedded before were checked for duplicates when they were (each check is a charged model request), so a
      // rerun asks nothing again: only the others are, a batch at a time, oldest first, each embedded and then checked
      // against every older post. Where a batch fails, the rest of it is unembedded again and the run stops there, so the
      // next run takes it up: none is left embedded but unchecked.
      const before = new Set((await prisma.postEmbedding.findMany({ select: { postId: true } })).map((e) => e.postId));
      const fresh = rows.filter((row) => !before.has(row.id));
      // Changed text is embedded again (not checked again: a post is checked once, when it's first embedded).
      let embedded = await embedPosts(rows.filter((row) => before.has(row.id)));
      let suggestions = 0;
      let failed: unknown = null;
      const done: typeof fresh = [];
      for (let i = 0; i < fresh.length && !failed; i += batchSize) {
        const batch = fresh.slice(i, i + batchSize);
        let checked = 0;
        try {
          embedded += await embedPosts(batch);
          for (const post of batch) {
            suggestions += await detectDuplicates(post.id);
            done.push(post);
            checked++;
          }
        } catch (error) {
          await prisma.postEmbedding.deleteMany({ where: { postId: { in: batch.slice(checked).map((post) => post.id) } } });
          failed = error;
        }
      }
      // A post embedded before but newer than one embedded now never saw it (a post is compared with older ones): it's
      // checked against those alone. Where that fails, they're unembedded again (as they were before this run), so the
      // next run checks them, and this, again; the rest carry on.
      for (const post of rows.filter((row) => before.has(row.id))) {
        const older = done.filter((row) => row.projectId === post.projectId && row.createdAt < post.createdAt).map((row) => row.id);
        if (older.length === 0) {
          continue;
        }
        try {
          suggestions += await detectDuplicates(post.id, older);
        } catch (error) {
          await prisma.postEmbedding.deleteMany({ where: { postId: { in: older } } });
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
