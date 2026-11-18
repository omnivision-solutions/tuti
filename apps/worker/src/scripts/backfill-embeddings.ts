/**
 * Embeds existing posts and suggests duplicates among them, and embeds published docs articles, for search; and indexes
 * every API reference's operations for the docs' search and AI answers (backfillEmbeddings). Without OPENAI_API_KEY only
 * the references are indexed (words only, no embeddings): their search needs it either way, posts' and articles' only
 * for meaning.
 * Run: pnpm --filter @tuti/worker backfill:embeddings
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { backfillEmbeddings } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

const { posts, articles, references } = await backfillEmbeddings({ info: () => {}, warn: console.warn });
if (posts && articles) {
  console.log(`${posts.posts} posts: embedded ${posts.embedded}, ${posts.suggestions} new duplicate suggestion(s)`);
  console.log(`${articles.articles} published articles: embedded ${articles.embedded} for search (the rest unchanged), ${articles.failed.length} failed`);
} else {
  console.log("OPENAI_API_KEY isn't set: posts and articles aren't embedded; API references are indexed for word search");
}
console.log(`${references.references} API references: indexed, ${references.failed.length} failed`);
await prisma.$disconnect();
const failed = (articles?.failed.length ?? 0) + references.failed.length;
if (failed > 0) {
  console.error(`${articles?.failed.length ?? 0} article(s) and ${references.failed.length} API reference(s) weren't embedded or indexed; run this again`);
  process.exitCode = 1;
}
