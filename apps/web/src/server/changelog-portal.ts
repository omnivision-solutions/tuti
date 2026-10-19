import { prisma } from "@tuti/db";

import type { PublishedEntry } from "@/components/changelog-entry";

import { displayDoc } from "./content";

/** A project's published changelog entries, newest first (or one of them, with `number`). */
export async function publishedEntries(projectSlug: string, { number, take = 50 }: { number?: number; take?: number } = {}) {
  const entries = await prisma.changelogEntry.findMany({
    where: { project: { slug: projectSlug }, publishedAt: { not: null }, ...(number !== undefined && { number }) },
    orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
    take,
    select: {
      number: true,
      title: true,
      tags: true,
      publishedAt: true,
      body: true,
      content: true,
      posts: { where: { post: { duplicateOfId: null } }, select: { post: { select: { number: true, title: true } } } },
    },
  });
  return entries.map(
    (e): PublishedEntry => ({
      number: e.number,
      title: e.title,
      tags: e.tags,
      publishedAt: e.publishedAt!,
      doc: displayDoc(e),
      posts: e.posts.map(({ post }) => post),
    }),
  );
}
