import { NextResponse } from "next/server";

import { type GithubAccount, type GithubConfig, signValue, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";

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
 * GitHub's web authorization flow, back to our callback with a signed `state`: the project (its slug, which never
 * changes: the router finds a project by it), the installation ("" while the person is choosing one), what it's for
 * ("choose", "install") and who started it (only they finish it: their GitHub access makes the project's list).
 */
export function authorizeRedirect(config: GithubConfig, project: { slug: string; userId: string }, installationId: number | "", purpose: string) {
  const authorize = new URL(`${config.url}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: new URL("/api/github/callback", appUrl()).href,
    state: signValue("callback", [project.slug, String(installationId), purpose, project.userId]),
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

/** Remembers the project (its slug) for 15 minutes while the person installs the App on GitHub. */
export function rememberInstall(response: NextResponse, slug: string) {
  response.cookies.set(INSTALL_COOKIE, signValue("install", [slug]), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl().protocol === "https:",
    path: "/api/github",
    maxAge: 15 * 60,
  });
  return response;
}
