import { prisma } from "@tuti/db";

import { boardPath } from "@/lib/post-urls";
import { PORTAL_BOARDS } from "./post-visibility";

/**
 * Where the portal's home opens (Customize → Navigation → Home page): the first board, the roadmap, the changelog
 * or the docs (null: no such project).
 */
export async function portalHomePath(slug: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { slug }, select: { portalHome: true } });
  if (!project) {
    return null;
  }
  if (project.portalHome !== "FEEDBACK") {
    return `/${project.portalHome.toLowerCase()}`;
  }
  // No board on the portal (all the team's): the changelog, which every portal has.
  return (await firstBoardPath(slug)) ?? "/changelog";
}

/** The portal's first board (/feedback opens it); a Team only board isn't on the portal. */
export async function firstBoardPath(slug: string): Promise<string | null> {
  const board = await prisma.board.findFirst({ where: { project: { slug }, ...PORTAL_BOARDS }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return board && boardPath(board);
}
