/**
 * Featurebase's API (v2), read-only, for imports (docs/plan.md, Switching from Featurebase). Its address is
 * FEATUREBASE_API_URL, so tests point it at the fake (@tuti/testkit); Featurebase itself otherwise.
 */

export const FEATUREBASE_VERSION = "2026-08-19.orbit";
const FEATUREBASE_URL = "https://do.featurebase.app";

/** Featurebase answered with an error (`status`), or couldn't be reached or read (0). */
export class FeaturebaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A file in Featurebase's own storage: its attachment host, or its API's own address (where the fake serves files).
 * Imports bring only these across; other sites' images are left where they are, as inbound email leaves them.
 */
export function inFeaturebaseStorage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)featurebase-attachments\.com$/i.test(parsed.hostname) || parsed.origin === new URL(process.env.FEATUREBASE_API_URL || FEATUREBASE_URL).origin;
  } catch {
    return false;
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

const UNREACHABLE = "Featurebase couldn't be reached.";
const UNREADABLE = "Featurebase's answer couldn't be read.";

/**
 * A client for one API key. `wait` is how it sleeps between tries (tests skip it). `deadline` (epoch ms): no request
 * starts, nor waits to be tried again, past it, so an import's page fits its job's time limit with time left to save.
 */
export function featurebase(key: string, { wait = pause, deadline = Infinity }: { wait?: (ms: number) => Promise<unknown>; deadline?: number } = {}) {
  const base = (process.env.FEATUREBASE_API_URL || FEATUREBASE_URL).replace(/\/$/, "");

  async function get<T>(path: string, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/v2${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    // The last answer's error, once one came: what a request the deadline stops returns instead.
    let last: FeaturebaseError | null = null;
    for (let attempt = 0; ; attempt++) {
      // Nothing starts past the deadline (a late wait, a slow error body, or one already passed).
      if (Date.now() >= deadline) {
        throw last ?? new FeaturebaseError(0, UNREACHABLE);
      }
      let response: Response | null = null;
      // An answer that was cut off or isn't JSON is tried again like no answer.
      let failure = new FeaturebaseError(0, UNREACHABLE);
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, "Featurebase-Version": FEATUREBASE_VERSION, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        if (response.ok) {
          return (await response.json()) as T;
        }
      } catch {
        if (response?.ok) {
          failure = new FeaturebaseError(0, UNREADABLE);
          response = null;
        }
      }
      const error = response ? new FeaturebaseError(response.status, await messageOf(response)) : failure;
      if ((!response || response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        const ms = waitFor(response, attempt);
        // Judged after the error's body was read, so its reading counts against the deadline too.
        if (Date.now() + ms < deadline) {
          last = error;
          await wait(ms);
          continue;
        }
      }
      throw error;
    }
  }

  /**
   * One page of a list (`cursor` null: the first), 100 at most (or `limit`); empty items (Featurebase sends null for some) left out.
   * The list goes on until Featurebase's cursor is null, as it documents, through empty pages too; a cursor that doesn't
   * move ends it, so a list can't loop.
   */
  async function page<T>(path: string, cursor: string | null, query: Record<string, string | number> = {}): Promise<Page<T>> {
    const body = await get<{ data: (T | null)[]; nextCursor?: string | null }>(path, { ...query, limit: query.limit ?? 100, cursor });
    const items = body.data.filter((item): item is T => item !== null);
    return { items, next: body.nextCursor && body.nextCursor !== cursor ? body.nextCursor : null };
  }

  return { get, page };
}

export type Featurebase = ReturnType<typeof featurebase>;

/** A Featurebase contact (GET /v2/contacts), as imports read it. */
export type FeaturebaseContact = {
  id: string;
  /** Their id in the team's own app (SSO), if it told Featurebase. */
  userId?: string | null;
  /** customer, or lead (someone who left an address without signing in: unproven). */
  type?: string | null;
  email?: string | null;
  name?: string | null;
  profilePicture?: string | null;
  customFields?: Record<string, unknown> | null;
  companies?: { name?: string | null }[] | null;
};

/** A Featurebase admin (GET /v2/admins): a member of their team there. */
export type FeaturebaseAdmin = { id: string; name?: string | null; email?: string | null; profilePicture?: string | null };

/** Words Featurebase keeps per locale ({ en: "…" }). */
export type FeaturebaseLocalized = Record<string, string> | null;

/** A Featurebase feedback board (GET /v2/boards: a bare array). */
export type FeaturebaseBoard = {
  id: string;
  name: string;
  access?: { adminOnly?: boolean; allowedRoles?: string[]; deniedRoles?: string[]; segments?: string[] } | null;
  /** Who its new posts are for: everyone, only their author (and the team), or the author's company. */
  postDefaults?: { visibility?: "public" | "authorOnly" | "companyOnly" } | null;
  localization?: { name?: FeaturebaseLocalized; description?: FeaturebaseLocalized; formPlaceholder?: FeaturebaseLocalized; submitButtonText?: FeaturebaseLocalized } | null;
};

/** Who wrote a post or comment: admins by their admin id, customers and leads by their contact id. */
export type FeaturebaseAuthor = { id: string | null; name?: string | null; email?: string | null; type: "admin" | "customer" | "lead" | "guest" | "integration" | "bot" } | null;

/** A Featurebase post (GET /v2/posts). */
export type FeaturebasePost = {
  id: string;
  title: string;
  /** HTML. */
  content: string;
  boardId: string;
  status: { name: string; type: "reviewing" | "unstarted" | "active" | "completed" | "canceled" };
  author: FeaturebaseAuthor;
  createdAt: string;
  updatedAt: string;
  eta: string | null;
  inReview: boolean;
  portalHidden: boolean;
  /** Non-empty: only these people (and admins) see it. */
  access?: { userIds?: string[]; companyExternalIds?: string[] } | null;
};

/** A post's voter (GET /v2/posts/{id}/voters): a contact (or admin), with when they were made, not when they voted. */
export type FeaturebaseVoter = FeaturebaseContact & { type: NonNullable<FeaturebaseAuthor>["type"]; createdAt?: string | null };

/** A Featurebase comment (GET /v2/comments): flat, replies naming their parent. */
export type FeaturebaseComment = {
  id: string;
  /** HTML. */
  content: string;
  /** Null for a changelog's comments. */
  postId: string | null;
  author: FeaturebaseAuthor;
  createdAt: string;
  isPrivate: boolean;
  inReview: boolean;
  isSpam: boolean;
  isDeleted: boolean;
};

/** A help center's collection (GET /v2/help_center/collections), in its default locale. `parentId` null: at the top. */
export type FeaturebaseCollection = {
  id: string;
  parentId?: string | null;
  name?: string | null;
  description?: string | null;
  /** `<id>-<name>`. */
  slug?: string | null;
  order?: number | null;
  /** An emoji, one of Featurebase's predefined icons (Heroicons' names: "CreditCardIcon"), or an image's address. */
  icon?: { type: string; value: string } | null;
  createdAt?: string | null;
};

/** A help center's article (GET /v2/help_center/articles?state=all), in its default locale: its live version, if it has one. */
export type FeaturebaseArticle = {
  id: string;
  /** Its collection; null: at the help center's top. */
  parentId?: string | null;
  title?: string | null;
  description?: string | null;
  /** HTML. */
  body?: string | null;
  /** `<id>-<title>`. */
  slug?: string | null;
  order?: number | null;
  state?: "live" | "draft";
  isPublished?: boolean;
  /** Its draft (GET /v2/help_center/articles/{id}?state=draft) has changes not published yet. Featurebase says so of many that have none. */
  isDraftDiffersFromLive?: boolean;
  /** Who may read it: ["everyone"], or only some people. */
  visibleBy?: string[] | null;
  author?: { authorId?: string | null; name?: string | null } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

/** A changelog entry (GET /v2/changelogs?state=all), in the default locale: its live version, if it has one. */
export type FeaturebaseChangelog = {
  id: string;
  title?: string | null;
  /** HTML. */
  content?: string | null;
  featuredImage?: string | null;
  /** When it's dated (published). */
  date?: string | null;
  state?: "live" | "draft";
  /** Who may see it: some segments only, when there are any; a category too, when it has roles. */
  allowedSegmentIds?: string[] | null;
  categories?: { id: string; name: string; roles?: string[] | null }[] | null;
  emailSentToSubscribers?: boolean;
  commentCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

/** Who wrote a conversation part: a contact (`customer`, `lead`: a contact id), an admin (an admin id), or someone else. */
export type FeaturebasePartAuthor = { id?: string | null; type?: string | null; name?: string | null; email?: string | null };

/** A part of a conversation (GET /v2/conversations/{id}): a message, a note, or an event (assign, status, …), by `partType`. */
export type FeaturebasePart = {
  id: string;
  partType: string;
  createdAt: string;
  bodyHtml?: string | null;
  bodyMarkdown?: string | null;
  channel?: string | null;
  author?: FeaturebasePartAuthor | null;
  status?: string | null;
};

/** A conversation in Featurebase's inbox (GET /v2/conversations; its parts, the newest 500, only from GET /v2/conversations/{id}). */
export type FeaturebaseConversation = {
  id: string;
  title?: string | null;
  state: "open" | "closed" | "snoozed";
  snoozedUntil?: string | null;
  adminAssigneeId?: string | null;
  participants?: { id: string; type: string }[] | null;
  source?: { channel?: string | null; subject?: string | null; bodyHtml?: string | null; author?: FeaturebasePartAuthor | null } | null;
  createdAt: string;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  readReceipts?: { id: string; userType: string; lastReadPartId: string }[] | null;
  conversationParts?: FeaturebasePart[] | null;
};
