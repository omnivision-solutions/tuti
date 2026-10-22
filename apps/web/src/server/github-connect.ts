import { prisma } from "@tuti/db";
import { syncRepositories } from "@tuti/jobs";
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
 * Connects the project to the installation. Its list is every repository the App can see on the
 * account (read with the App's own access); a project starts with none of them, for the team to add.
 */
export async function saveConnection(project: { id: string; userId: string }, installationId: number, account: GithubAccount) {
  const connection = await prisma.$transaction(async (tx) => {
    const existing = await tx.githubInstallation.findUnique({ where: { projectId: project.id }, select: { id: true, installationId: true } });
    const switched = existing !== null && existing.installationId !== installationId;
    if (switched) {
      // Connected to another account before: its repositories go, and so does its list.
      await tx.githubRepository.deleteMany({ where: { connectionId: existing.id } });
    }
    const data = { installationId, accountLogin: account.login, accountType: account.type, ...(switched && { repositories: [] }) };
    return tx.githubInstallation.upsert({
      where: { projectId: project.id },
      update: data,
      create: { ...data, projectId: project.id, createdById: project.userId },
      select: { id: true },
    });
  });
  // Best effort: connected either way, and Refresh list tries again.
  await syncRepositories(connection.id, installationId).catch((error: unknown) =>
    log.warn("Couldn't list a GitHub installation's repositories", { error, installationId }),
  );
}
