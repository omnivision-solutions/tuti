import { prisma } from "@tuti/db";

import { boardPath } from "@/lib/post-urls";

/**
 * Where the portal's home opens (Customize → Home page): the first board, the roadmap, the changelog
 * or the docs; null for a portal with nothing there (no project, or no board).
 */
export async function portalHomePath(slug: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { portalHome: true } });
  if (!project) {
    return null;
  }
  if (project.portalHome !== "FEEDBACK") {
    return `/${project.portalHome.toLowerCase()}`;
  }
  return firstBoardPath(slug);
}

/** The portal's first board (/feedback opens it). */
export async function firstBoardPath(slug: string): Promise<string | null> {
  const board = await prisma.board.findFirst({ where: { project: { slug } }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return board && boardPath(board);
}
