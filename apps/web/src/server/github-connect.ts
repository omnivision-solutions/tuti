import { prisma } from "@tuti/db";
import { type GithubRepo, syncRepositories } from "@tuti/jobs";
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
 * installation ("" while the person is choosing one), what it's for ("choose", "install") and who
 * started it (only they finish it: their GitHub access makes the project's list).
 */
export function authorizeRedirect(config: GithubConfig, project: { id: string; userId: string }, installationId: number | "", purpose: string) {
  const authorize = new URL(`${config.url}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: new URL("/api/github/callback", appUrl()).href,
    state: signValue("callback", [project.id, String(installationId), purpose, project.userId]),
  }).toString();
  return NextResponse.redirect(authorize);
}

/**
 * Whether the browser doesn't say one of the app's own pages sent it here. Connecting starts only from
 * the app's own pages (Connect GitHub, Reconnect): another site, a portal (a subdomain, "same-site"),
 * or a link opened from a chat or mail app ("none") mustn't start it for a signed-in admin, whose
 * access on GitHub would then make the project's list. A browser that sends no Sec-Fetch-Site (every
 * current one does) can't connect. GitHub's own returns go to the Setup and Callback URLs.
 */
export const crossSite = (request: Request) => request.headers.get("sec-fetch-site") !== "same-origin";

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
 * Connects the project to the installation (again, to list repositories given access since). Its
 * list is the installation's repositories the person who connected can access on GitHub
 * (`accessible`), and those the project already has; a project starts with none of them, for the
 * team to add. Seeing an installation takes access to only one of its repositories, so the list
 * mustn't be what the App can see.
 */
export async function saveConnection(project: { id: string; userId: string }, installationId: number, account: GithubAccount, accessible: GithubRepo[]) {
  const connection = await prisma.$transaction(async (tx) => {
    const existing = await tx.githubInstallation.findUnique({ where: { projectId: project.id }, select: { id: true, installationId: true } });
    const switched = existing !== null && existing.installationId !== installationId;
    if (switched) {
      // Connected to another account before: its repositories go, and so does its list.
      await tx.githubRepository.deleteMany({ where: { connectionId: existing.id } });
    }
    // The project's repositories stay listed, even if this person can't access them: someone who could added them.
    const included = existing && !switched ? await tx.githubRepository.findMany({ where: { connectionId: existing.id }, select: { repoId: true, fullName: true } }) : [];
    const ids = new Set(accessible.map((repo) => repo.id));
    const repositories = [...accessible, ...included.filter((repo) => !ids.has(repo.repoId)).map((repo) => ({ id: repo.repoId, fullName: repo.fullName }))];
    const data = { installationId, accountLogin: account.login, accountType: account.type, repositories };
    return tx.githubInstallation.upsert({
      where: { projectId: project.id },
      update: data,
      create: { ...data, projectId: project.id, createdById: project.userId },
      select: { id: true },
    });
  });
  // Best effort (drops what the App can't see any more): connected either way, and Refresh list tries again.
  await syncRepositories(connection.id, installationId).catch((error: unknown) =>
    log.warn("Couldn't list a GitHub installation's repositories", { error, installationId }),
  );
}
