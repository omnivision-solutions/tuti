import { createSign } from "node:crypto";

/**
 * The GitHub API as the Tuti App (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY; GITHUB_API_URL
 * for GitHub Enterprise and tests). The App signs a short JWT, swaps it for a token
 * scoped to one installation, and reads that installation's repositories with it.
 */

const apiUrl = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

/** A JWT that identifies the App itself (RS256, valid for 9 minutes). */
export function appJwt(now = Date.now()): string {
  const appId = process.env.GITHUB_APP_ID;
  // Private keys in env vars often have their newlines escaped.
  const key = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
  if (!appId || !key) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const seconds = Math.floor(now / 1000);
  // Issued a minute early, as GitHub recommends, in case clocks differ.
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

export type GithubApi = {
  get<T>(path: string): Promise<T>;
  /** Like `get`, but null when GitHub answers 404 (other errors still throw). */
  find<T>(path: string): Promise<T | null>;
  /** All pages of a list (following the Link header), up to `limit` pages. */
  list<T>(path: string, pick: (page: unknown) => T[], limit?: number): Promise<T[]>;
};

/** API access for one installation. */
export async function installationApi(installationId: number): Promise<GithubApi> {
  const response = await fetch(`${apiUrl()}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt()}`, "user-agent": "Tuti" },
  });
  if (!response.ok) {
    throw new Error(`GitHub refused an installation token (${response.status})`);
  }
  const { token } = (await response.json()) as { token: string };
  const request = async (url: string, notFoundIsNull = false) => {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "Tuti" },
    });
    if (notFoundIsNull && res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${url.replace(apiUrl(), "")} answered ${res.status}`);
    }
    return res;
  };
  return {
    async get<T>(path: string) {
      return (await (await request(`${apiUrl()}${path}`))!.json()) as T;
    },
    async find<T>(path: string) {
      const res = await request(`${apiUrl()}${path}`, true);
      return res ? ((await res.json()) as T) : null;
    },
    async list(path, pick, limit = 10) {
      const items = [];
      let url: string | null = `${apiUrl()}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      for (let page = 0; url && page < limit; page++) {
        const res: Response = (await request(url))!;
        items.push(...pick(await res.json()));
        url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
      }
      return items;
    },
  };
}
