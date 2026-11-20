import { prisma } from "@tuti/db";
import { embeddingsEnabled } from "@tuti/shared";

import { indexApiReferences } from "./api-references";
import { embedPublishedArticles } from "./articles";
import type { JobLogger } from "./index";
import { detectDuplicates, embedPosts } from "./duplicates";

/**
 * The embeddings backfill (the worker's backfill:embeddings): embeds existing posts and suggests duplicates for those
 * not checked yet,
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
        select: { id: true, projectId: true, title: true, body: true, createdAt: true, duplicatesCheckedAt: true },
      });
      // Embed everything first, then check, oldest first, each post not checked yet (each check is a charged model
      // request, so a rerun asks nothing again) against every older post. One whose check fails stays unchecked, for the
      // next run; the rest carry on.
      const embedded = await embedPosts(rows);
      let suggestions = 0;
      let failed: unknown = null;
      const done: typeof rows = [];
      for (const post of rows.filter((row) => !row.duplicatesCheckedAt)) {
        try {
          suggestions += await detectDuplicates(post.id);
          done.push(post);
        } catch (error) {
          failed ??= error;
        }
      }
      // A post checked before but newer than one checked now never saw it (a post is compared with older ones): it's
      // checked against those alone. Where that fails, they're marked unchecked again, so the next run checks them, and
      // this, again.
      const doneIn = new Map<string, typeof done>();
      for (const row of done) {
        const list = doneIn.get(row.projectId);
        if (list) {
          list.push(row);
        } else {
          doneIn.set(row.projectId, [row]);
        }
      }
      for (const post of rows.filter((row) => row.duplicatesCheckedAt)) {
        const older = (doneIn.get(post.projectId) ?? []).filter((row) => row.createdAt < post.createdAt).map((row) => row.id);
        if (older.length === 0) {
          continue;
        }
        try {
          suggestions += await detectDuplicates(post.id, older);
        } catch (error) {
          await prisma.post.updateMany({ where: { id: { in: older } }, data: { duplicatesCheckedAt: null } });
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
