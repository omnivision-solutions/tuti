import { prisma } from "@tuti/db";
import { type GithubRepo, includeRepositories } from "@tuti/jobs";

import { getAccountSession } from "./session";

/** Cookie that remembers which project is being connected while the person is on GitHub. */
export const INSTALL_COOKIE = "tuti_github_install";

/** The project, if the signed-in account (on the app host) is one of its owners or admins. */
export async function adminProject(where: { id: string } | { slug: string }) {
  const session = await getAccountSession();
  if (!session) {
    return null;
  }
  const project = await prisma.project.findFirst({
    where: { ...where, team: { some: { userId: session.user.id, role: { in: ["OWNER", "ADMIN"] } } } },
    select: { id: true, slug: true },
  });
  return project && { ...project, userId: session.user.id };
}

/** Holds an installation's connections still while one changes, so two can't both take new repositories. */
export const lockInstallation = (tx: Pick<typeof prisma, "$executeRaw">, installationId: number) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('github-installation'), ${installationId})`;

/**
 * Connects the project to the installation, or refreshes its repositories (`repositories`: the
 * ones the person who came back from GitHub can access). The first project to connect an
 * installation takes its repositories, and new ones later; a project that connects one
 * another project uses starts with none, for the team to include.
 */
export async function saveConnection(
  project: { id: string; userId: string },
  installationId: number,
  account: { login: string; repositories: GithubRepo[] },
) {
  const { connectionId, fresh } = await prisma.$transaction(async (tx) => {
    await lockInstallation(tx, installationId);
    const existing = await tx.githubInstallation.findUnique({
      where: { projectId: project.id },
      select: {
        id: true,
        installationId: true,
        includeNewRepositories: true,
        seenRepositoryIds: true,
        included: { select: { repoId: true, fullName: true } },
      },
    });
    const same = existing?.installationId === installationId;
    if (existing && !same) {
      // Connected to another account before: its repositories go.
      await tx.githubRepository.deleteMany({ where: { connectionId: existing.id } });
    }
    const others = await tx.githubInstallation.count({ where: { installationId, projectId: { not: project.id } } });
    const includeNew = same ? existing.includeNewRepositories : others === 0;
    const seen = new Set(same ? existing.seenRepositoryIds : []);
    // What's listed: what the person can access, and what's included already.
    const included = same ? existing.included.map((repo) => ({ id: repo.repoId, fullName: repo.fullName })) : [];
    const repositories = [...account.repositories, ...included.filter((repo) => !account.repositories.some((r) => r.id === repo.id))];
    const data = {
      installationId,
      accountLogin: account.login,
      includeNewRepositories: includeNew,
      repositories,
      seenRepositoryIds: [...new Set([...seen, ...account.repositories.map((repo) => repo.id)])],
    };
    const connection = await tx.githubInstallation.upsert({
      where: { projectId: project.id },
      update: data,
      create: { ...data, projectId: project.id, createdById: project.userId },
      select: { id: true },
    });
    return {
      connectionId: connection.id,
      fresh: includeNew ? account.repositories.filter((repo) => !seen.has(repo.id)) : [],
    };
  });
  await includeRepositories(connectionId, installationId, fresh);
}
