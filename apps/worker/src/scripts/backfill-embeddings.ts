/**
 * Embeds existing posts and suggests duplicates among them, and embeds published help articles for search.
 * Run: pnpm --filter @tuti/worker backfill:embeddings
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { articleChanged, detectDuplicates, embedPosts } from "@tuti/jobs";

assertEnv(["DATABASE_URL", "OPENAI_API_KEY"]);

const posts = await prisma.post.findMany({
  where: { duplicateOfId: null },
  orderBy: { createdAt: "asc" },
  select: { id: true, projectId: true, title: true, body: true },
});

// Embed everything first, then compare, so every post sees all older ones.
const embedded = await embedPosts(posts);
let suggestions = 0;
for (const post of posts) {
  suggestions += await detectDuplicates(post.id);
}
console.log(`${posts.length} posts: embedded ${embedded}, ${suggestions} new duplicate suggestion(s)`);

// Published help articles, for search (unchanged ones are skipped).
const articles = await prisma.article.findMany({ where: { publishedAt: { not: null } }, select: { id: true } });
for (const { id } of articles) {
  await articleChanged({ articleId: id }, { info: () => {}, warn: console.warn });
}
console.log(`${articles.length} published articles embedded for search`);
await prisma.$disconnect();
