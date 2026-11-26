/**
 * Embeds existing posts and suggests duplicates among them, and embeds published docs articles, for search; and indexes
 * every API reference's operations for the docs' search and AI answers (backfillEmbeddings). Without OPENAI_API_KEY only
 * the references are indexed (words only, no embeddings): their search needs it either way, posts' and articles' only
 * for meaning. A phase that fails is reported and fails the run, and stops none of the others.
 * Run: pnpm --filter @tuti/worker backfill:embeddings
 */
import { prisma } from "@tuti/db";
import { assertEnv, embeddingsEnabled } from "@tuti/shared";

import { backfillEmbeddings } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

const { posts, articles, references, errors } = await backfillEmbeddings({ info: () => {}, warn: console.warn });
if (!embeddingsEnabled()) {
  console.log("OPENAI_API_KEY isn't set: posts and articles aren't embedded; API references are indexed for word search");
}
if (posts) {
  console.log(`${posts.posts} posts: embedded ${posts.embedded}, ${posts.suggestions} new duplicate suggestion(s)`);
}
if (articles) {
  console.log(`${articles.articles} published articles: embedded ${articles.embedded} for search (the rest unchanged), ${articles.failed.length} failed`);
  console.log(`${articles.translations} published translations: embedded ${articles.translationsEmbedded} (the rest unchanged), ${articles.translationsFailed.length} failed`);
}
if (references) {
  console.log(`${references.references} API references: indexed, ${references.failed.length} failed`);
}
await prisma.$disconnect();
for (const { phase, message } of errors) {
  console.error(`The ${phase} phase failed: ${message}`);
}
const failed = (articles?.failed.length ?? 0) + (articles?.translationsFailed.length ?? 0) + (references?.failed.length ?? 0);
if (failed > 0) {
  console.error(
    `${articles?.failed.length ?? 0} article(s), ${articles?.translationsFailed.length ?? 0} translation(s) and ${references?.failed.length ?? 0} API reference(s) weren't embedded or indexed; run this again`,
  );
}
if (errors.length > 0 || failed > 0) {
  process.exitCode = 1;
}
