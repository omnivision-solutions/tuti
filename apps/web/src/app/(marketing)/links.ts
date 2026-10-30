import { prisma } from "@tuti/db";

import { appPortalMount } from "@/lib/app-portal";

export const REPO_URL = "https://github.com/omnivision-solutions/tuti";

/** Tuti's own docs: on its own portal where the server has one (and its project exists), else in the repository. */
export async function docsUrl(): Promise<string> {
  const mount = appPortalMount();
  if (mount && (await prisma.project.findUnique({ where: { slug: mount.slug }, select: { id: true } }))) {
    return `${mount.origin}${mount.path}/docs`;
  }
  return `${REPO_URL}/tree/main/docs`;
}
