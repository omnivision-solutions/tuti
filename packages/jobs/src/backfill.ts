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
      // Posts embedded before were checked for duplicates when they were (each check is a charged model request), so a
      // rerun asks nothing again: only the others are, a batch at a time, oldest first, each embedded and then checked
      // against every older post. A batch that fails is unembedded again, so the next run takes it up where this one
      // stopped: none is left embedded but unchecked.
      const before = new Set((await prisma.postEmbedding.findMany({ select: { postId: true } })).map((e) => e.postId));
      const fresh = rows.filter((row) => !before.has(row.id));
      // Changed text is embedded again (not checked again: a post is checked once, when it's first embedded).
      let embedded = await embedPosts(rows.filter((row) => before.has(row.id)));
      let suggestions = 0;
      for (let i = 0; i < fresh.length; i += 100) {
        const batch = fresh.slice(i, i + 100);
        try {
          embedded += await embedPosts(batch);
          for (const post of batch) {
            suggestions += await detectDuplicates(post.id);
          }
        } catch (error) {
          await prisma.postEmbedding.deleteMany({ where: { postId: { in: batch.map((post) => post.id) } } });
          throw error;
        }
      }
      // A post embedded before but newer than one embedded now never saw it (a post is compared with older ones): it's
      // checked against those alone. A failure here unembeds nothing (that post was checked); the rest carry on and the
      // run reports it.
      // ponytail: a run that stopped at a failed batch leaves its earlier batches embedded, so the next run doesn't check
      // older posts against them again; a per-post "checked" mark would, if backfills ever fail in practice.
      let failed: unknown = null;
      for (const post of rows.filter((row) => before.has(row.id))) {
        const older = fresh.filter((row) => row.projectId === post.projectId && row.createdAt < post.createdAt).map((row) => row.id);
        if (older.length > 0) {
          suggestions += await detectDuplicates(post.id, older).catch((error: unknown) => {
            failed ??= error;
            return 0;
          });
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
