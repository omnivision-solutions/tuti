import { type Prisma, prisma } from "@tuti/db";

import { installationApi } from "./github-api";

/**
 * Which project a repository's pull requests and releases go to. A project connects a GitHub
 * App installation (a user or organisation), several projects may connect the same one, and
 * each includes repositories of it: one project per repository (GithubRepository).
 */

/** A repository as GitHub names it: its id never changes, its owner/name may. */
export type GithubRepo = { id: number; fullName: string };

/** The repositories listed for a connection (its `repositories` column). */
export function listedRepositories(value: Prisma.JsonValue): GithubRepo[] {
  return Array.isArray(value)
    ? value.filter(
        (repo): repo is GithubRepo =>
          typeof repo === "object" && repo !== null && typeof (repo as GithubRepo).id === "number" && typeof (repo as GithubRepo).fullName === "string",
      )
    : [];
}

const connectionSelect = {
  id: true,
  closeOn: true,
  commentOnPullRequests: true,
  project: { select: { id: true, slug: true, name: true } },
} as const;

export type RepositoryConnection = Prisma.GithubInstallationGetPayload<{ select: typeof connectionSelect }>;

/**
 * Includes these repositories of `installationId` in the connection, except those another project
 * includes. With `takeOver` (only once GitHub has said these repositories are in this installation
 * now), one included from another installation was moved (transferred to another account), so it
 * starts over here. `db`: a transaction to do it in (otherwise it has one of its own).
 */
export async function includeRepositories(
  connectionId: string,
  installationId: number,
  repos: GithubRepo[],
  { db, takeOver = false }: { db?: Prisma.TransactionClient; takeOver?: boolean } = {},
): Promise<void> {
  if (repos.length === 0) {
    return;
  }
  // Both or neither: a moved one deleted and not included would be in no project.
  if (!db) {
    return prisma.$transaction((tx) => includeRepositories(connectionId, installationId, repos, { db: tx, takeOver }));
  }
  if (takeOver) {
    const ids = repos.map((repo) => repo.id);
    await db.githubRepository.deleteMany({ where: { repoId: { in: ids }, connection: { installationId: { not: installationId } } } });
  }
  await db.githubRepository.createMany({
    data: repos.map((repo) => ({ connectionId, repoId: repo.id, fullName: repo.fullName })),
    skipDuplicates: true,
  });
}

/**
 * The project a repository's events go to: the one that includes it, if the event comes from
 * the installation it was included from. A repository Tuti hasn't seen is new: the project of
 * that installation which takes new repositories (if one does) includes it now (taking it from
 * another installation's project only once GitHub says it's in this one). One a project has seen
 * and left out stays out.
 */
export async function repositoryConnection(installationId: number, repo: GithubRepo): Promise<RepositoryConnection | null> {
  const found = await prisma.githubRepository.findUnique({
    where: { repoId: repo.id },
    select: { id: true, fullName: true, connection: { select: { ...connectionSelect, installationId: true } } },
  });
  if (found && found.connection.installationId === installationId) {
    if (found.fullName !== repo.fullName) {
      await prisma.githubRepository.update({ where: { id: found.id }, data: { fullName: repo.fullName } });
    }
    const { installationId: _, ...connection } = found.connection;
    return connection;
  }
  const taker = await prisma.githubInstallation.findFirst({
    where: { installationId, includeNewRepositories: true },
    select: { ...connectionSelect, seenRepositoryIds: true },
  });
  if (!taker) {
    return null;
  }
  const { seenRepositoryIds, ...connection } = taker;
  if (seenRepositoryIds.includes(repo.id)) {
    return null;
  }
  // Held from another installation: an event can arrive late, after the repository moved on, so
  // only GitHub's word now takes it from that project.
  if (found && !(await inInstallation(installationId, repo.id))) {
    return null;
  }
  // Taking it from that project only with GitHub's word; a claim that lands meanwhile stays.
  await includeRepositories(taker.id, installationId, [repo], { takeOver: found !== null });
  // Listed, and seen now, so leaving it out later sticks.
  await prisma.$executeRaw`
    UPDATE github_installation SET
      repositories = CASE WHEN repositories @> ${JSON.stringify([{ id: repo.id }])}::jsonb THEN repositories
                          ELSE repositories || ${JSON.stringify([repo])}::jsonb END,
      "seenRepositoryIds" = array_append(array_remove("seenRepositoryIds", ${repo.id}), ${repo.id})
    WHERE id = ${taker.id}`;
  // Another delivery may have included it first (or elsewhere): whoever holds it now.
  const holder = await prisma.githubRepository.findUnique({ where: { repoId: repo.id }, select: { connectionId: true } });
  return holder?.connectionId === taker.id ? connection : null;
}

/** GitHub ids of the repositories the installation can access now (up to 10,000, 100 a page). Throws if GitHub can't say. */
async function installationRepositoryIds(installationId: number): Promise<Set<number>> {
  const api = await installationApi(installationId);
  const repositories = await api.list<{ id: number }>("/installation/repositories", (page) => (page as { repositories: { id: number }[] }).repositories, 100);
  return new Set(repositories.map((repo) => repo.id));
}

/**
 * Whether GitHub says the repository is in the installation now: it's among the repositories the
 * installation can access (reading it by id isn't proof: any token reads a public repository).
 * False if GitHub can't say. Only asked when a repository would change project.
 */
export async function inInstallation(installationId: number, repoId: number): Promise<boolean> {
  try {
    return (await installationRepositoryIds(installationId)).has(repoId);
  } catch {
    return false;
  }
}

/**
 * Repositories removed from the installation on GitHub: they leave their project and every
 * project's list, and are forgotten, so added back they're new again. Deliveries can arrive out
 * of order, so only those GitHub says are gone now; throws if GitHub can't say.
 */
export async function forgetRepositories(installationId: number, repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) {
    return;
  }
  const current = await installationRepositoryIds(installationId);
  const gone = repoIds.filter((id) => !current.has(id));
  if (gone.length === 0) {
    return;
  }
  await prisma.$transaction([
    prisma.githubRepository.deleteMany({ where: { repoId: { in: gone }, connection: { installationId } } }),
    prisma.$executeRaw`
      UPDATE github_installation SET
        repositories = COALESCE(
          (SELECT jsonb_agg(repo) FROM jsonb_array_elements(repositories) repo WHERE (repo->>'id')::int <> ALL(${gone}::int[])),
          '[]'::jsonb),
        "seenRepositoryIds" = ARRAY(SELECT id FROM unnest("seenRepositoryIds") id WHERE id <> ALL(${gone}::int[]))
      WHERE "installationId" = ${installationId}`,
  ]);
}
