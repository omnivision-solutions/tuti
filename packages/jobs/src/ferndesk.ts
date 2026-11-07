/**
 * Ferndesk's public API (v1), read-only, for imports (docs/plan.md, Import from Ferndesk). Its address is
 * FERNDESK_API_URL, so tests point it at the fake (@tuti/testkit); Ferndesk itself otherwise.
 */

import type { Page } from "./featurebase";

const FERNDESK_URL = "https://api.ferndesk.com";

/** Ferndesk answered with an error (`status`), or couldn't be reached or read (0). */
export class FerndeskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How many times a request that failed for a while (429, 5xx, no answer) is tried again, and the longest wait between. */
const RETRIES = 4;
const MAX_WAIT_MS = 60_000;
const TIMEOUT_MS = 30_000;
const UNREACHABLE = "Ferndesk couldn't be reached.";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Its error's message ({ error: "…" }). */
async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Ferndesk answered ${response.status}`;
}

/**
 * A client for one API key. `wait` is how it sleeps between tries (tests skip it). `deadline` (epoch ms): no request
 * starts, nor waits to be tried again, past it, so an import's page fits its job's time limit.
 */
export function ferndesk(key: string, { wait = pause, deadline = Infinity }: { wait?: (ms: number) => Promise<unknown>; deadline?: number } = {}) {
  const base = (process.env.FERNDESK_API_URL || FERNDESK_URL).replace(/\/$/, "");

  async function get<T>(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/v1${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    let last: FerndeskError | null = null;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline) {
        throw last ?? new FerndeskError(0, UNREACHABLE);
      }
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        if (response.ok) {
          return (await response.json()) as T;
        }
      } catch {
        // No answer, or one cut off: tried again like none.
        response = null;
      }
      const error = response ? new FerndeskError(response.status, await messageOf(response)) : new FerndeskError(0, UNREACHABLE);
      if ((!response || response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        const ms = Math.min(Number(response?.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt, MAX_WAIT_MS);
        if (Date.now() + ms < deadline) {
          last = error;
          await wait(ms);
          continue;
        }
      }
      throw error;
    }
  }

  /** One page of a list (`cursor` null: the first), 100 at most (or `page_size`); a cursor that doesn't move ends it. */
  async function page<T>(path: string, cursor: string | null, query: Record<string, string | number> = {}): Promise<Page<T>> {
    const body = await get<{ results: T[]; has_more: boolean; next_cursor: string | null }>(path, { page_size: 100, ...query, start_cursor: cursor });
    return { items: body.results, next: body.has_more && body.next_cursor && body.next_cursor !== cursor ? body.next_cursor : null };
  }

  /** Every page of a list. */
  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const next: Page<T> = await page<T>(path, cursor);
      items.push(...next.items);
      cursor = next.next;
    } while (cursor);
    return items;
  }

  return { get, page, all };
}

/** A top-level section of the help center's navigation (GET /v1/sections). */
export type FerndeskSection = { id: string; name: string; position: number; isDefault: boolean; createdAt: string };

/** A collection (GET /v1/collections), in the default language. */
export type FerndeskCollection = {
  id: string;
  sectionId: string | null;
  parentCollectionId: string | null;
  title: string;
  subtitle: string | null;
  /** In its public address: `<slug>-<shortId>`. */
  shortId: string | null;
  createdAt: string;
};

/** An article (GET /v1/articles?status=all&format=html), in the default language: its current body. */
export type FerndeskArticle = {
  id: string;
  title: string;
  slug: string | null;
  contentHtml?: string | null;
  /** Its public address, `…/<slug>-<shortId>`. */
  url: string | null;
  sectionId: string | null;
  collectionId: string | null;
  status: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An article's open draft (GET /v1/articles/{id}/drafts, without its body; GET …/drafts/{draftId} with it). */
export type FerndeskDraft = { id: string; language: string | null; status: string; stale: boolean; title?: string | null; contentHtml?: string | null };

/** Someone who signed in to the help center (GET /v1/users). */
export type FerndeskUser = { id: string; email: string; name: string | null; attributes: Record<string, unknown> | null };

/** An AI assistant conversation (GET /v1/assistant/conversations/{id}; the list leaves out its transcript). */
export type FerndeskConversation = {
  id: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string | null } | null;
  summary: string | null;
  transcript?: { role: "user" | "assistant"; text: string }[];
};
