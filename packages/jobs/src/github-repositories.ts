import { type Prisma, prisma } from "@tuti/db";

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
 * includes. A repository included from another installation was moved (transferred to another
 * account): GitHub says it's in this one now, so it starts over here.
 */
export async function includeRepositories(connectionId: string, installationId: number, repos: GithubRepo[]): Promise<void> {
  if (repos.length === 0) {
    return;
  }
  const ids = repos.map((repo) => repo.id);
  await prisma.githubRepository.deleteMany({ where: { repoId: { in: ids }, connection: { installationId: { not: installationId } } } });
  await prisma.githubRepository.createMany({
    data: repos.map((repo) => ({ connectionId, repoId: repo.id, fullName: repo.fullName })),
    skipDuplicates: true,
  });
}

/**
 * The project a repository's events go to: the one that includes it, if the event comes from
 * the installation it was included from. A repository Tuti hasn't seen is new: the project of
 * that installation which takes new repositories (if one does) includes it now. One a project
 * has seen and left out stays out.
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
  await includeRepositories(taker.id, installationId, [repo]);
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
