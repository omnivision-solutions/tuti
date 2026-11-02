import { prisma } from "@tuti/db";
import { plansEnabled } from "@tuti/shared";

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

/**
 * The repository's GitHub stars, refreshed hourly. Only on Tuti's cloud (a self-hosted server doesn't call
 * GitHub unasked); null when GitHub can't be reached (a rate limit) or doesn't know the repository (the tests' fake).
 */
export async function githubStars(): Promise<number | null> {
  if (!plansEnabled()) return null;
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${api}/repos/${new URL(REPO_URL).pathname.slice(1)}`, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as { stargazers_count: number }).stargazers_count : null;
  } catch {
    return null;
  }
}
