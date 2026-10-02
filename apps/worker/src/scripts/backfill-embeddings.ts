/**
 * Embeds existing posts and suggests duplicates among them.
 * Run: pnpm --filter @tuti/worker backfill:embeddings
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { detectDuplicates, embedPosts } from "../duplicates";

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
await prisma.$disconnect();
