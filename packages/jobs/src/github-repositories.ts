import { type Prisma, prisma } from "@tuti/db";

import { installationApi } from "./github-api";

/**
 * Which project a repository's pull requests and releases go to. A project connects a GitHub
 * App installation (a user or organisation), several projects may connect the same one, and
 * the team adds repositories of it to each: one project per repository (GithubRepository).
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
 * Adds these repositories of `installationId` to the connection, except those another project
 * has. With `takeOver` (only once GitHub has said these repositories are in this installation
 * now), one held from another installation was moved (transferred to another account), so it
 * starts over here. In one transaction: a moved one deleted and not added would be in no project.
 */
export async function includeRepositories(
  connectionId: string,
  installationId: number,
  repos: GithubRepo[],
  { takeOver = false }: { takeOver?: boolean } = {},
): Promise<void> {
  if (repos.length === 0) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    if (takeOver) {
      const ids = repos.map((repo) => repo.id);
      await tx.githubRepository.deleteMany({ where: { repoId: { in: ids }, connection: { installationId: { not: installationId } } } });
    }
    await tx.githubRepository.createMany({
      data: repos.map((repo) => ({ connectionId, repoId: repo.id, fullName: repo.fullName })),
      skipDuplicates: true,
    });
  });
}

/**
 * The project a repository's events go to: the one the team added it to, if the event comes from
 * the installation it was added from (one transferred to another account is added again there).
 * Repositories no project has are ignored.
 */
export async function repositoryConnection(installationId: number, repo: GithubRepo): Promise<RepositoryConnection | null> {
  const found = await prisma.githubRepository.findUnique({
    where: { repoId: repo.id },
    select: { id: true, fullName: true, connection: { select: { ...connectionSelect, installationId: true } } },
  });
  if (!found || found.connection.installationId !== installationId) {
    return null;
  }
  if (found.fullName !== repo.fullName) {
    await prisma.githubRepository.update({ where: { id: found.id }, data: { fullName: repo.fullName } });
  }
  const { installationId: _, ...connection } = found.connection;
  return connection;
}

/** The repositories the installation can access now (up to 10,000, 100 a page), as the App reads them. Throws if GitHub can't say. */
export async function installationRepositories(installationId: number): Promise<GithubRepo[]> {
  const api = await installationApi(installationId);
  type Page = { repositories: { id: number; full_name: string }[] };
  const repositories = await api.list<{ id: number; full_name: string }>("/installation/repositories", (page) => (page as Page).repositories, 100);
  return repositories.map((repo) => ({ id: repo.id, fullName: repo.full_name }));
}

const installationRepositoryIds = async (installationId: number) =>
  new Set((await installationRepositories(installationId)).map((repo) => repo.id));

/**
 * The connection's list, from GitHub now: every repository the App can see on the account.
 * The project's repositories that GitHub no longer has leave it. Throws if GitHub can't say.
 */
export async function syncRepositories(connectionId: string, installationId: number): Promise<GithubRepo[]> {
  const repositories = await installationRepositories(installationId);
  const ids = repositories.map((repo) => repo.id);
  await prisma.$transaction([
    prisma.githubRepository.deleteMany({ where: { connectionId, repoId: { notIn: ids } } }),
    prisma.githubInstallation.update({ where: { id: connectionId }, data: { repositories } }),
  ]);
  return repositories;
}

/**
 * Whether GitHub says the repository is in the installation now: it's among the repositories the
 * installation can access (reading it by id isn't proof: any token reads a public repository).
 * Throws if GitHub can't say. Only asked when a repository would change project.
 */
export async function inInstallation(installationId: number, repoId: number): Promise<boolean> {
  return (await installationRepositoryIds(installationId)).has(repoId);
}

/**
 * Repositories removed from the installation on GitHub: they leave their project and every
 * project's list. Deliveries can arrive out of order, so only those GitHub says are gone now;
 * throws if GitHub can't say.
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
          '[]'::jsonb)
      WHERE "installationId" = ${installationId}`,
  ]);
}
