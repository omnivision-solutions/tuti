import { createHmac, timingSafeEqual } from "node:crypto";

import type { GithubRepo } from "@tuti/jobs";

import * as signed from "./signed";

/**
 * The Tuti GitHub App (Phase 7), set up with env vars. Self-hosters register their
 * own App; GITHUB_URL and GITHUB_API_URL exist for GitHub Enterprise and tests.
 */
export type GithubConfig = {
  appSlug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  url: string;
  apiUrl: string;
};

export function githubConfig(): GithubConfig | null {
  const env = process.env;
  // All or nothing: connecting without the App's ID and key would fail later, at the first release.
  const required = [
    env.GITHUB_APP_SLUG,
    env.GITHUB_APP_CLIENT_ID,
    env.GITHUB_APP_CLIENT_SECRET,
    env.GITHUB_WEBHOOK_SECRET,
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
  ];
  if (required.some((value) => !value)) {
    return null;
  }
  return {
    appSlug: env.GITHUB_APP_SLUG!,
    clientId: env.GITHUB_APP_CLIENT_ID!,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    url: (env.GITHUB_URL || "https://github.com").replace(/\/$/, ""),
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
  };
}

const SIGNED_TTL_SECONDS = 15 * 60;

/**
 * A short-lived value only we can make, for one purpose (the install cookie, the
 * OAuth state), so it can't be forged, swapped between purposes or reused later.
 */
export const signValue = (purpose: string, fields: string[], now = Date.now()) =>
  signed.signValue(`github:${purpose}`, fields, SIGNED_TTL_SECONDS, now);

/** The fields of a valid, unexpired value signed for `purpose`; null otherwise. */
export const verifyValue = (purpose: string, value: string, now = Date.now()) => signed.verifyValue(`github:${purpose}`, value, now);

/** Webhook deliveries are signed with the App's webhook secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyWebhookSignature(secret: string, body: string, header: string | null): boolean {
  const signature = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!signature) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Proof that a person can see an installation (GitHub's setup redirect only says
 * which installation, and anyone can type one): after GitHub's web authorization
 * flow, we exchange its `code` and look for the installation among that user's
 * installations. Returns the installation's account and the repositories of it the
 * person can access (only those can be included in a project), or null.
 */
export async function installationForUser(config: GithubConfig, code: string, redirectUri: string, installationId: number) {
  const tokenResponse = await fetch(`${config.url}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
  });
  const { access_token: token } = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!token) {
    return null;
  }
  // Paged, 100 at a time, following GitHub's Link header; up to 10,000 (as the App reads its
  // repositories elsewhere). Throws if GitHub refuses.
  async function* pages<T>(path: string) {
    let url: string | null = `${config.apiUrl}${path}?per_page=100`;
    for (let page = 0; url && page < 100; page++) {
      const response: Response = await fetch(url, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "Tuti" },
      });
      if (!response.ok) {
        throw new Error(`GitHub ${path} answered ${response.status}`);
      }
      yield (await response.json()) as T;
      url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
    }
  }
  let account: { login: string } | undefined;
  for await (const { installations } of pages<{ installations: { id: number; account: { login: string } }[] }>("/user/installations")) {
    account = installations.find((i) => i.id === installationId)?.account;
    if (account) {
      break;
    }
  }
  if (!account) {
    return null;
  }
  const repositories: GithubRepo[] = [];
  for await (const page of pages<{ repositories: { id: number; full_name: string }[] }>(`/user/installations/${installationId}/repositories`)) {
    repositories.push(...page.repositories.map((repo) => ({ id: repo.id, fullName: repo.full_name })));
  }
  return { login: account.login, repositories };
}
