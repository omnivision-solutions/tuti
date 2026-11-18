import { prisma } from "@tuti/db";
import { embeddingsEnabled } from "@tuti/shared";

import { indexApiReferences } from "./api-references";
import { embedPublishedArticles } from "./articles";
import type { JobLogger } from "./index";
import { detectDuplicates, embedPosts } from "./duplicates";

/**
 * The embeddings backfill (the worker's backfill:embeddings): embeds existing posts and suggests duplicates among them,
 * and embeds published docs articles for search, when embeddings are set up; then indexes every API reference's
 * operations for the docs' search and AI answers, set up or not (their word search needs it either way).
 */
export async function backfillEmbeddings(log: JobLogger) {
  let posts = null;
  let articles = null;
  if (embeddingsEnabled()) {
    const rows = await prisma.post.findMany({
      // Never sample content (Home's "Add sample content"): it's never embedded or suggested as a duplicate.
      where: { duplicateOfId: null, sample: false },
      orderBy: { createdAt: "asc" },
      select: { id: true, projectId: true, title: true, body: true },
    });
    // Embed everything first, then compare, so every post sees all older ones.
    const embedded = await embedPosts(rows);
    let suggestions = 0;
    for (const post of rows) {
      suggestions += await detectDuplicates(post.id);
    }
    posts = { posts: rows.length, embedded, suggestions };
    // Published docs articles, for search (unchanged ones are skipped).
    articles = await embedPublishedArticles(log);
  }
  // API references' operations (references added before they were indexed, too).
  const references = await indexApiReferences(log);
  return { posts, articles, references };
}
