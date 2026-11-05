/**
 * Featurebase's API (v2), read-only, for imports (docs/plan.md, Switching from Featurebase). Its address is
 * FEATUREBASE_API_URL, so tests point it at the fake (@tuti/testkit); Featurebase itself otherwise.
 */

export const FEATUREBASE_VERSION = "2026-08-19.orbit";
const FEATUREBASE_URL = "https://do.featurebase.app";

/** Featurebase answered with an error (`status`), or couldn't be reached (0). */
export class FeaturebaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A list's page, and where the next one starts (null: it was the last). */
export type Page<T> = { items: T[]; next: string | null };

/** How many times a request that failed for a while (429, 5xx, no answer) is tried again, and the longest wait between. */
const RETRIES = 4;
const MAX_WAIT_MS = 60_000;
const TIMEOUT_MS = 30_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before trying again: what Featurebase says (Retry-After, or its rate limit's reset), else 0.5s doubling up to 8s. */
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

/** The error's message from either of Featurebase's shapes ({ error: { message } }, { message }). */
async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown; error?: { message?: unknown } } | null;
  const message = body?.error?.message ?? body?.message;
  return typeof message === "string" ? message : `Featurebase answered ${response.status}`;
}

/** A client for one API key. `wait` is how it sleeps between tries (tests skip it). */
export function featurebase(key: string, { wait = pause }: { wait?: (ms: number) => Promise<unknown> } = {}) {
  const base = (process.env.FEATUREBASE_API_URL || FEATUREBASE_URL).replace(/\/$/, "");

  async function get<T>(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/v2${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, "Featurebase-Version": FEATUREBASE_VERSION, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // No answer: tried again like a 5xx.
      }
      if (response?.ok) {
        return (await response.json()) as T;
      }
      if ((!response || response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        await response?.body?.cancel();
        await wait(waitFor(response, attempt));
        continue;
      }
      throw response ? new FeaturebaseError(response.status, await messageOf(response)) : new FeaturebaseError(0, "Featurebase couldn't be reached.");
    }
  }

  /** One page of a list (`cursor` null: the first), 100 at most; empty items (Featurebase sends null for some) left out. */
  async function page<T>(path: string, cursor: string | null, query: Record<string, string | number> = {}): Promise<Page<T>> {
    const body = await get<{ data: (T | null)[]; nextCursor?: string | null }>(path, { ...query, limit: 100, cursor });
    const items = body.data.filter((item): item is T => item !== null);
    // An empty page ends it too, whatever its cursor says.
    return { items, next: body.data.length > 0 && body.nextCursor ? body.nextCursor : null };
  }

  return { get, page };
}

export type Featurebase = ReturnType<typeof featurebase>;

/** A Featurebase contact (GET /v2/contacts), as imports read it. */
export type FeaturebaseContact = {
  id: string;
  /** Their id in the team's own app (SSO), if it told Featurebase. */
  userId?: string | null;
  email?: string | null;
  name?: string | null;
  profilePicture?: string | null;
  customFields?: Record<string, unknown> | null;
  companies?: { name?: string | null }[] | null;
};

/** A Featurebase admin (GET /v2/admins): a member of their team there. */
export type FeaturebaseAdmin = { id: string; name?: string | null; email?: string | null; profilePicture?: string | null };
