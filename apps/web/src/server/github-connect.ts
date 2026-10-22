import { prisma } from "@tuti/db";
import { forgetRepositories, type GithubRepo } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { NextResponse } from "next/server";

import { type GithubAccount, type GithubConfig, signValue, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";

import { getAccountSession } from "./session";

/** Cookie that remembers which project is being connected while the person is on GitHub. */
export const INSTALL_COOKIE = "tuti_github_install";

/** Cookie with the GitHub accounts "Connect GitHub" found the person has Tuti on, for them to pick one. */
export const ACCOUNTS_COOKIE = "tuti_github_accounts";

/** The accounts in ACCOUNTS_COOKIE, if it's ours, fresh and for this project. */
export function accountsFromCookie(value: string, projectId: string): { id: number; account: GithubAccount }[] {
  const [forProject, ...accounts] = verifyValue("accounts", value) ?? [];
  if (forProject !== projectId) {
    return [];
  }
  return accounts.map((entry) => {
    const [id, type, login] = entry.split(":");
    return { id: Number(id), account: { login: login ?? "", type: type ?? "Organization" } };
  });
}

/**
 * GitHub's web authorization flow, back to our callback with a signed `state`: the project, the
 * installation ("" while the person is choosing one) and what it's for ("choose", "install", "refresh").
 */
export function authorizeRedirect(config: GithubConfig, projectId: string, installationId: number | "", purpose: string) {
  const authorize = new URL(`${config.url}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: new URL("/api/github/callback", appUrl()).href,
    state: signValue("callback", [projectId, String(installationId), purpose]),
  }).toString();
  return NextResponse.redirect(authorize);
}

/** Remembers the project for 15 minutes while the person installs the App on GitHub. */
export function rememberInstall(response: NextResponse, projectId: string) {
  response.cookies.set(INSTALL_COOKIE, signValue("install", [projectId]), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl().protocol === "https:",
    path: "/api/github",
    maxAge: 15 * 60,
  });
  return response;
}

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

/**
 * Connects the project to the installation, or refreshes its list (`repositories`: the ones the
 * person who came back from GitHub can access). A project starts with no repositories: the team
 * adds the ones that belong to it.
 */
export async function saveConnection(
  project: { id: string; userId: string },
  installationId: number,
  account: { login: string; type: string; repositories: GithubRepo[] },
) {
  const unlisted = await prisma.$transaction(async (tx) => {
    const existing = await tx.githubInstallation.findUnique({
      where: { projectId: project.id },
      select: { id: true, installationId: true, included: { select: { repoId: true, fullName: true } } },
    });
    const same = existing?.installationId === installationId;
    if (existing && !same) {
      // Connected to another account before: its repositories go.
      await tx.githubRepository.deleteMany({ where: { connectionId: existing.id } });
    }
    // What's listed: what the person can access, and what the project has already.
    const included = same ? existing.included.map((repo) => ({ id: repo.repoId, fullName: repo.fullName })) : [];
    const repositories = [...account.repositories, ...included.filter((repo) => !account.repositories.some((r) => r.id === repo.id))];
    const data = { installationId, accountLogin: account.login, accountType: account.type, repositories };
    await tx.githubInstallation.upsert({
      where: { projectId: project.id },
      update: data,
      create: { ...data, projectId: project.id, createdById: project.userId },
    });
    return included.filter((repo) => !account.repositories.some((r) => r.id === repo.id)).map((repo) => repo.id);
  });
  // The project's, but not listed for this person: if GitHub says they've left the installation (a
  // removal whose webhook never came), they go. Best effort: the refresh itself is done.
  await forgetRepositories(installationId, unlisted).catch((error: unknown) =>
    log.warn("Couldn't check GitHub for removed repositories", { error, installationId }),
  );
}
