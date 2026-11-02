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

/** The repository's GitHub stars, refreshed hourly; null when GitHub can't be reached (a server offline, a rate limit). */
export async function githubStars(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/omnivision-solutions/tuti", { next: { revalidate: 3600 }, signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as { stargazers_count: number }).stargazers_count : null;
  } catch {
    return null;
  }
}
