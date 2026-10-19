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
  if (!env.GITHUB_APP_SLUG || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET || !env.GITHUB_WEBHOOK_SECRET) {
    return null;
  }
  return {
    appSlug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    url: (env.GITHUB_URL || "https://github.com").replace(/\/$/, ""),
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
  };
}

const STATE_TTL_SECONDS = 15 * 60;
const stateKey = () => `github-install:${process.env.BETTER_AUTH_SECRET}`;

/** The install link's `state`: which project asked, signed and short-lived, so it can't be swapped. */
export function signInstallState(projectId: string, now = Date.now()): string {
  const payload = `${projectId}.${Math.floor(now / 1000) + STATE_TTL_SECONDS}`;
  return `${payload}.${createHmac("sha256", stateKey()).update(payload).digest("base64url")}`;
}

/** The project id from a valid, unexpired state; null otherwise. */
export function verifyInstallState(state: string, now = Date.now()): string | null {
  const [projectId, expires, signature] = state.split(".");
  if (!projectId || !expires || !signature) {
    return null;
  }
  const expected = createHmac("sha256", stateKey()).update(`${projectId}.${expires}`).digest("base64url");
  const valid =
    signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return valid && Number(expires) * 1000 > now ? projectId : null;
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
 * Proof that the person installing can see this installation: GitHub's user
 * authorization during install gives a `code`; with it we ask GitHub which
 * installations that user has. Returns the installation's account, or null.
 */
export async function installationForUser(config: GithubConfig, code: string, installationId: number) {
  const tokenResponse = await fetch(`${config.url}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  const { access_token: token } = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!token) {
    return null;
  }
  const response = await fetch(`${config.apiUrl}/user/installations?per_page=100`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "Tuti" },
  });
  if (!response.ok) {
    return null;
  }
  const { installations } = (await response.json()) as { installations: { id: number; account: { login: string } }[] };
  return installations.find((i) => i.id === installationId)?.account ?? null;
}
