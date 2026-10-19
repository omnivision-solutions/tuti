import { createHmac, timingSafeEqual } from "node:crypto";

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
const signingKey = (purpose: string) => `github:${purpose}:${process.env.BETTER_AUTH_SECRET}`;

/**
 * A short-lived value only we can make, for one purpose (the install cookie, the
 * OAuth state), so it can't be forged, swapped between purposes or reused later.
 */
export function signValue(purpose: string, fields: string[], now = Date.now()): string {
  const payload = [...fields, String(Math.floor(now / 1000) + SIGNED_TTL_SECONDS)].join(".");
  return `${payload}.${createHmac("sha256", signingKey(purpose)).update(payload).digest("base64url")}`;
}

/** The fields of a valid, unexpired value signed for `purpose`; null otherwise. */
export function verifyValue(purpose: string, value: string, now = Date.now()): string[] | null {
  const parts = value.split(".");
  const signature = parts.pop();
  const expires = parts.at(-1);
  if (!signature || !expires || parts.length < 2) {
    return null;
  }
  const expected = createHmac("sha256", signingKey(purpose)).update(parts.join(".")).digest("base64url");
  // Compare bytes: a crafted value can have the right number of characters but not of bytes.
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  const valid = given.length === wanted.length && timingSafeEqual(given, wanted);
  return valid && Number(expires) * 1000 > now ? parts.slice(0, -1) : null;
}

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
 * installations. Returns the installation's account, or null.
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
  // Page through them (100 at a time, following GitHub's Link header; capped).
  let url: string | null = `${config.apiUrl}/user/installations?per_page=100`;
  for (let page = 0; url && page < 20; page++) {
    const response: Response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "Tuti" },
    });
    if (!response.ok) {
      return null;
    }
    const { installations } = (await response.json()) as { installations: { id: number; account: { login: string } }[] };
    const found = installations.find((i) => i.id === installationId);
    if (found) {
      return found.account;
    }
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  }
  return null;
}
