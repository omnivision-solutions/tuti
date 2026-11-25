import { prisma } from "@tuti/db";

import { installationApi } from "./github-api";

/** A merged pull request as GitHub lists it, on one of the project's included repositories. */
export type MergedPull = { repoId: number; repo: string; number: number; title: string; url: string; author: string; mergedAt: string };

type Listed = { number: number; title: string; html_url?: string; user?: { login?: string } | null; merged_at?: string | null; updated_at?: string };

/** Pages of 100 read for one repository at most: 2,000 closed pull requests updated since the date asked for. */
const MAX_PAGES = 20;

const asMerged = (repo: { repoId: number; fullName: string }, pr: Listed): MergedPull | null =>
  pr.merged_at
    ? {
        repoId: repo.repoId,
        repo: repo.fullName,
        number: pr.number,
        title: pr.title,
        // The page GitHub's webhook names (the running draft's key for it).
        url: pr.html_url ?? `https://github.com/${repo.fullName}/pull/${pr.number}`,
        author: pr.user?.login ?? "",
        mergedAt: pr.merged_at,
      }
    : null;

/** The project's GitHub connection and the repositories it includes; null when GitHub isn't connected. */
const connection = (projectId: string) =>
  prisma.githubInstallation.findUnique({ where: { projectId }, select: { installationId: true, included: { select: { repoId: true, fullName: true }, orderBy: { fullName: "asc" } } } });

/**
 * The pull requests merged on the project's included repositories since `since`, newest first, with the repositories
 * (as named now); null when GitHub isn't connected. Read from GitHub as they are now (titles since edited, ones merged
 * before the app was installed): each repository's closed pull requests, latest updated first, page by page until one
 * was last updated before `since` (merged since then, it was updated since then too), so an early date reaches as far
 * back as it asks. A repository with more than MAX_PAGES pages since then is read as far as they go: `since` is then
 * the latest date every repository was read back to, and only those merged since it are listed.
 */
export async function mergedPullRequests(
  projectId: string,
  since: Date,
): Promise<{ since: Date; pullRequests: MergedPull[]; repos: { repoId: number; fullName: string }[] } | null> {
  const github = await connection(projectId);
  if (!github) {
    return null;
  }
  const api = await installationApi(github.installationId);
  // One repository after another, a page at a time: an early date is many requests, and the installation's rate limit
  // is shared with everything else Tuti reads from GitHub.
  const found: MergedPull[] = [];
  let covered = since;
  for (const repo of github.included) {
    for (let page = 1; ; page++) {
      const listed = await api.get<Listed[]>(`/repos/${repo.fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
      found.push(...listed.map((pr) => asMerged(repo, pr)).filter((pr): pr is MergedPull => pr !== null && new Date(pr.mergedAt) >= since));
      const last = listed.at(-1)?.updated_at;
      // The last page, or everything from here on was last touched before the date asked for.
      if (listed.length < 100 || last === undefined || new Date(last) < since) {
        break;
      }
      // As far as it's read: everything merged since this one's last touch has been listed.
      if (page === MAX_PAGES) {
        covered = new Date(Math.max(covered.getTime(), new Date(last).getTime()));
        break;
      }
    }
  }
  return {
    since: covered,
    pullRequests: found.filter((pr) => new Date(pr.mergedAt) >= covered).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)),
    repos: github.included,
  };
}

/**
 * These pull requests of the project's, each by repository and number, as GitHub has them, in the order asked: "unknown"
 * for a repository the project doesn't include or a number it doesn't have, "open" for one that isn't merged. Null when
 * GitHub isn't connected. One installation token for them all, read one after another (a request names up to 50).
 */
export async function mergedPullRequestsByRef(projectId: string, refs: { repo: string; number: number }[]): Promise<(MergedPull | "unknown" | "open")[] | null> {
  const github = await connection(projectId);
  if (!github) {
    return null;
  }
  const api = await installationApi(github.installationId);
  const read: (MergedPull | "unknown" | "open")[] = [];
  for (const { repo, number } of refs) {
    const included = github.included.find((each) => each.fullName.toLowerCase() === repo.toLowerCase());
    const pr = included && (await api.find<Listed>(`/repos/${included.fullName}/pulls/${number}`));
    read.push(included && pr ? (asMerged(included, pr) ?? "open") : "unknown");
  }
  return read;
}
