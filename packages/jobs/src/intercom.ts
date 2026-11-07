/**
 * Intercom's REST API, read-only, for imports (docs/plan.md, Import from Intercom). Its address is INTERCOM_API_URL, so
 * tests point it at the fake (@tuti/testkit); otherwise Intercom's, in whichever region (US, EU, Australia) takes the
 * token: a workspace's token works only at its own region's address.
 */

export const INTERCOM_VERSION = "2.17";
const REGIONS = ["https://api.intercom.io", "https://api.eu.intercom.io", "https://api.au.intercom.io"];

/** Intercom answered with an error (`status`), or couldn't be reached or read (0). */
export class IntercomError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RETRIES = 4;
const MAX_WAIT_MS = 60_000;
const TIMEOUT_MS = 30_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before trying again: Retry-After, else its rate limit's reset (epoch seconds), else 0.5s doubling up to 8s. */
function waitFor(response: Response | null, attempt: number): number {
  const after = Number(response?.headers.get("retry-after"));
  if (after > 0) {
    return Math.min(after * 1000, MAX_WAIT_MS);
  }
  const reset = Number(response?.headers.get("x-ratelimit-reset"));
  if (response?.status === 429 && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_WAIT_MS);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

/** Intercom's errors: { type: "error.list", errors: [{ code, message }] }. */
async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { errors?: { message?: unknown }[] } | null;
  const message = body?.errors?.[0]?.message;
  return typeof message === "string" ? message : `Intercom answered ${response.status}`;
}

/**
 * A client for one access token: retries for 429, 5xx and no answer, and nothing starts past `deadline` (epoch ms), as
 * Featurebase's does. Until a request succeeds, a 401 tries the next region.
 */
export function intercom(token: string, { wait = pause, deadline = Infinity }: { wait?: (ms: number) => Promise<unknown>; deadline?: number } = {}) {
  const bases = process.env.INTERCOM_API_URL ? [process.env.INTERCOM_API_URL.replace(/\/$/, "")] : REGIONS;
  let region = 0;
  let found = false;
  /** Intercom's clock at its last answer (Unix seconds, its Date header), null before one. */
  let serverTime: number | null = null;

  async function request<T>(base: string, path: string, query: Record<string, string | number | null | undefined>): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    let last: IntercomError | null = null;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline) {
        throw last ?? new IntercomError(0, "Intercom couldn't be reached.");
      }
      let response: Response | null = null;
      let failure = new IntercomError(0, "Intercom couldn't be reached.");
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, "Intercom-Version": INTERCOM_VERSION, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        if (response.ok) {
          const date = Date.parse(response.headers.get("date") ?? "");
          serverTime = Number.isNaN(date) ? null : Math.floor(date / 1000);
          return (await response.json()) as T;
        }
      } catch {
        if (response?.ok) {
          failure = new IntercomError(0, "Intercom's answer couldn't be read.");
          response = null;
        }
      }
      const error = response ? new IntercomError(response.status, await messageOf(response)) : failure;
      if ((!response || response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        const ms = waitFor(response, attempt);
        if (Date.now() + ms < deadline) {
          last = error;
          await wait(ms);
          continue;
        }
      }
      throw error;
    }
  }

  async function get<T>(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    for (;;) {
      try {
        const body = await request<T>(bases[region]!, path, query);
        found = true;
        return body;
      } catch (error) {
        if (!found && error instanceof IntercomError && error.status === 401 && region < bases.length - 1) {
          region++;
          continue;
        }
        throw error;
      }
    }
  }

  /** Intercom's clock at its last answer (Unix seconds), else this machine's. */
  const now = () => serverTime ?? Math.floor(Date.now() / 1000);

  return { get, now };
}

/** A list's pages (help center lists: numbered). */
export type IntercomPages = { page?: number; total_pages?: number; next?: { starting_after?: string | null } | string | null };

/** An Intercom contact (GET /contacts), as imports read it. */
export type IntercomContact = {
  id: string;
  external_id?: string | null;
  /** user, or lead (unproven: an address left without signing in). */
  role?: string | null;
  email?: string | null;
  name?: string | null;
  /** A URL (older versions: { image_url }). */
  avatar?: string | { image_url?: string | null } | null;
  custom_attributes?: Record<string, unknown> | null;
  companies?: { data?: { id: string }[] | null } | null;
};

/** An Intercom admin (GET /admins). */
export type IntercomAdmin = { id: string | number; name?: string | null; email?: string | null; avatar?: { image_url?: string | null } | null };

/** A help center collection (GET /help_center/collections), in its default locale. */
export type IntercomCollection = {
  id: string | number;
  parent_id?: string | number | null;
  name?: string | null;
  description?: string | null;
  url?: string | null;
  order?: number | null;
  created_at?: number | null;
};

/** A help center article (GET /articles), in its default locale. */
export type IntercomArticle = {
  id: string | number;
  title?: string | null;
  description?: string | null;
  /** HTML. */
  body?: string | null;
  author_id?: string | number | null;
  state?: "published" | "draft";
  url?: string | null;
  parent_id?: string | number | null;
  parent_ids?: (string | number)[] | null;
  /** everyone, or some people only (all_users, all_leads, …, restricted). */
  help_center_audience?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
};
