import { prisma } from "@tuti/db";

/** Posts a changelog entry can complete: planned, in progress or done (most recent first), plus any it already lists. */
export async function completablePosts(projectId: string, listed: number[] = []) {
  const posts = await prisma.post.findMany({
    where: {
      projectId,
      duplicateOfId: null,
      OR: [{ status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] } }, { number: { in: listed } }],
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { number: true, title: true, status: true },
  });
  return posts;
}
