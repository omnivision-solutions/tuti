"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

export type SimilarPost = { id: string; number: number; title: string; voteCount: number; boardName: string };

const querySchema = z.string().trim().min(3).max(120);

/**
 * Existing posts that look like the title being typed, across the project's
 * boards, so people vote instead of posting duplicates. Trigram similarity of
 * the whole title, or of the typed words within a longer title.
 */
export async function findSimilarPosts(projectSlug: string, title: string): Promise<SimilarPost[]> {
  const query = querySchema.safeParse(title);
  if (!query.success) {
    return [];
  }
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  if (!project) {
    return [];
  }

  return prisma.$queryRaw<SimilarPost[]>`
    SELECT p.id, p.number, p.title, p."voteCount", b.name AS "boardName"
    FROM post p
    JOIN board b ON b.id = p."boardId"
    WHERE p."projectId" = ${project.id}
      AND p."duplicateOfId" IS NULL
      AND (p.title % ${query.data} OR ${query.data} <% p.title)
    ORDER BY greatest(similarity(p.title, ${query.data}), word_similarity(${query.data}, p.title)) DESC,
      p."voteCount" DESC
    LIMIT 5`;
}
