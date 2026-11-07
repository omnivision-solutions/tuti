import { marked } from "marked";

import type { FeaturebaseAuthor, FeaturebaseBoard, FeaturebaseChangelog, FeaturebaseComment, FeaturebaseContact, FeaturebasePost, FeaturebaseVoter, Page } from "../featurebase";
import type { ImportSourceDefinition } from "./index";

/**
 * Canny's API, read-only, for imports (docs/plan.md, Import from Canny): every request a POST with the key in its body.
 * Its address is CANNY_API_URL, so tests point it at the fake (@tuti/testkit); Canny itself otherwise.
 */

const CANNY_URL = "https://canny.io/api";

/** Canny answered with an error (`status`), or couldn't be reached or read (0). */
export class CannyError extends Error {
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
const UNREACHABLE = "Canny couldn't be reached.";

/**
 * A client for one API key. What fails for a while (429, 5xx, no answer) is tried again, after Retry-After or 0.5s
 * doubling up to 8s; nothing starts, nor waits to be tried again, past `deadline` (epoch ms). `wait` is how it sleeps
 * between tries (tests skip it).
 */
export function canny(key: string, deadline: number, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const base = (process.env.CANNY_API_URL || CANNY_URL).replace(/\/$/, "");
  return async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    let last: CannyError | null = null;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline) {
        throw last ?? new CannyError(0, UNREACHABLE);
      }
      let response: Response | null = null;
      try {
        response = await fetch(`${base}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ apiKey: key, ...body }),
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        if (response.ok) {
          return (await response.json()) as T;
        }
      } catch {
        // No answer, or one cut off: tried again.
        response = null;
      }
      const message = response && ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error;
      const text = typeof message === "string" ? message : response ? `Canny answered ${response.status}` : UNREACHABLE;
      // Canny refuses a bad key with a 4xx saying so: as a refusal (401), whichever code it uses.
      const status = response ? (response.status < 500 && /api ?key/i.test(text) ? 401 : response.status) : 0;
      const error = new CannyError(status, text);
      if ((status === 0 || status === 429 || status >= 500) && attempt < RETRIES) {
        const after = Number(response?.headers.get("retry-after"));
        const ms = after > 0 ? Math.min(after * 1000, MAX_WAIT_MS) : Math.min(500 * 2 ** attempt, 8_000);
        if (Date.now() + ms < deadline) {
          last = error;
          await wait(ms);
          continue;
        }
      }
      throw error;
    }
  };
}

/** Null for a record Canny no longer has (it answers 400 or 404 for an id it doesn't know). */
const unlessGone = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (error instanceof CannyError && (error.status === 400 || error.status === 404)) {
      return null;
    }
    throw error;
  });

/** A Canny user (end-user or admin), as its lists and posts give them. */
type CannyUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  avatarURL?: string | null;
  isAdmin?: boolean;
  /** Their id in the team's app, if they signed in through it (SSO) or the API added them. */
  userID?: string | null;
  customFields?: Record<string, unknown> | null;
  companies?: { name?: string | null }[] | null;
  created?: string | null;
};
type CannyPost = {
  id: string;
  title?: string | null;
  details?: string | null;
  imageURLs?: string[] | null;
  board: { id: string };
  author?: CannyUser | null;
  status?: string | null;
  statusChangedAt?: string | null;
  /** A month and year: "February 2026". */
  eta?: string | null;
  /** Whether everyone sees its ETA (else only the team). */
  etaPublic?: boolean | null;
  created: string;
};
type CannyComment = {
  id: string;
  value?: string | null;
  imageURLs?: string[] | null;
  post?: { id: string } | null;
  author?: CannyUser | null;
  internal?: boolean;
  /** Seen only by its author and the team (the board hides end-users' comments from each other). */
  private?: boolean;
  created: string;
};
type CannyEntry = {
  id: string;
  title?: string | null;
  markdownDetails?: string | null;
  status?: "draft" | "scheduled" | "published";
  publishedAt?: string | null;
  scheduledFor?: string | null;
  types?: string[] | null;
  posts?: { id: string }[] | null;
  created?: string | null;
  lastSaved?: string | null;
};
type Cursored<K extends string, T> = { [key in K]?: T[] } & { hasNextPage?: boolean; cursor?: string | null };

/** Only someone with an id in the team's app is a proven customer; anyone else's address is as unproven as a lead's. */
const kind = (user: CannyUser): NonNullable<FeaturebaseAuthor>["type"] => (user.isAdmin ? "admin" : user.userID?.trim() ? "customer" : "lead");

const contactOf = (user: CannyUser): FeaturebaseContact => ({
  id: user.id,
  userId: user.userID,
  type: kind(user),
  email: user.email,
  name: user.name,
  profilePicture: user.avatarURL,
  customFields: user.customFields,
  companies: user.companies,
});

const authorOf = (user: CannyUser | null | undefined): FeaturebaseAuthor => (user ? { id: user.id, name: user.name, email: user.email, type: kind(user) } : null);

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Canny's plain text (paragraphs by blank lines) and its images after it, as HTML. */
export const textHtml = (text: string | null | undefined, images: string[] | null | undefined) =>
  [
    ...(text ?? "")
      .split(/\n\s*\n/)
      .filter((paragraph) => paragraph.trim())
      .map((paragraph) => `<p>${escape(paragraph.trim()).replace(/\n/g, "<br>")}</p>`),
    ...(images ?? []).map((url) => `<p><img src="${escape(url)}"></p>`),
  ].join("");

/** Canny's ETA, a month ("February 2026"), as its first day; null when it isn't one. */
function eta(month: string | null | undefined): string | null {
  const date = month ? new Date(`1 ${month} UTC`) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** Canny's statuses by name (postStatus reads Tuti's by theirs); a status of the team's own comes as Open. */
const postOf = (post: CannyPost): FeaturebasePost => ({
  id: post.id,
  title: post.title ?? "",
  content: textHtml(post.details, post.imageURLs),
  boardId: post.board.id,
  // Canny gives only its name: postStatus maps it by that.
  status: { name: post.status === "complete" ? "completed" : (post.status ?? "open") } as FeaturebasePost["status"],
  author: authorOf(post.author),
  createdAt: post.created,
  updatedAt: post.statusChangedAt ?? post.created,
  // Only one everyone saw: Tuti's portal shows a post's ETA, and has no ETA for the team alone. Canny's own default
  // is private, so one it doesn't say is public stays out.
  eta: post.etaPublic === true ? eta(post.eta) : null,
  inReview: false,
  portalHidden: false,
});

const commentOf = (comment: CannyComment): FeaturebaseComment => ({
  id: comment.id,
  content: textHtml(comment.value, comment.imageURLs),
  postId: comment.post?.id ?? null,
  author: authorOf(comment.author),
  createdAt: comment.created,
  // Internal ones are the team's notes; private ones (only their author and the team see them) are notes when the team wrote them, else left out.
  isPrivate: Boolean(comment.internal || comment.private),
  inReview: false,
  isSpam: false,
  isDeleted: false,
});

/** When an entry is dated: published, else scheduled, else made. */
const entryDate = (entry: CannyEntry) => entry.publishedAt ?? entry.scheduledFor ?? entry.created ?? null;

const entryOf = (entry: CannyEntry): FeaturebaseChangelog => ({
  id: entry.id,
  title: entry.title,
  content: marked.parse(entry.markdownDetails ?? "", { async: false }),
  date: entryDate(entry),
  // Scheduled ones come as drafts, to publish here.
  state: entry.status === "published" ? "live" : "draft",
  // Its types (new, improved, fixed) as the categories Tuti's tags are read from.
  categories: (entry.types ?? []).map((type) => ({ id: type, name: type })),
  postIds: (entry.posts ?? []).map((post) => post.id),
  createdAt: entry.created,
  updatedAt: entry.lastSaved,
});

/** A cursor-paged list's page (Canny's v2 lists), its next cursor null at the end or when it doesn't move. */
function page<T>(body: { hasNextPage?: boolean; cursor?: string | null }, items: T[], cursor: string | null): Page<T> {
  return { items, next: body.hasNextPage && body.cursor && body.cursor !== cursor ? body.cursor : null };
}

export const cannySource: ImportSourceDefinition = {
  name: "Canny",
  credential: "key",
  status: (error) => (error instanceof CannyError ? error.status : null),
  connect: (key, { deadline }) => {
    const post = canny(key, deadline);
    return {
      checkCredential: () => post("v1/boards/list"),
      checks: {
        contacts: () => post("v2/users/list", { limit: 1 }),
        feedback: () => Promise.all([post("v1/boards/list"), post("v1/posts/list", { limit: 1 })]),
        changelog: () => post("v1/entries/list", { limit: 1 }),
        // It reads only what's here: nothing to check.
        avatars: async () => undefined,
      },
      read: {
        // Canny's API lists no admins: each post, comment and vote names its own (name and email), which is all
        // adminMember needs. So there's no Team part either.
        admins: async () => [],
        contacts: async (cursor) => {
          const body = await post<Cursored<"users", CannyUser>>("v2/users/list", { limit: 100, ...(cursor && { cursor }) });
          // The team are its admins, not its users.
          return page(body, (body.users ?? []).filter((user) => !user.isAdmin).map(contactOf), cursor);
        },
        contact: async (id) => {
          const user = await unlessGone(post<CannyUser>("v1/users/retrieve", { id }));
          return user && contactOf(user);
        },
        boards: async () =>
          (await post<{ boards: { id: string; name: string; isPrivate?: boolean }[] }>("v1/boards/list")).boards.map(
            // A private board is only for the people the team lets in: left out, as Featurebase's restricted ones.
            (board): FeaturebaseBoard => ({ id: board.id, name: board.name, access: board.isPrivate ? { adminOnly: true } : null }),
          ),
        posts: async (cursor) => {
          const skip = Number(cursor ?? 0);
          const body = await post<{ posts: CannyPost[]; hasMore?: boolean }>("v1/posts/list", { sort: "oldest", limit: 100, skip });
          return { items: body.posts.map(postOf), next: body.hasMore && body.posts.length > 0 ? String(skip + body.posts.length) : null };
        },
        voters: async (postId, cursor) => {
          const body = await unlessGone(post<Cursored<"items", { voter: CannyUser | null; created?: string | null }>>("v2/votes/list", { postID: postId, limit: 100, ...(cursor && { cursor }) }));
          // Canny keeps when each vote was cast: that's its date (votesPage dates none before its post). A voter Canny
          // has deleted (null) is no one to bring.
          return body && page(body, (body.items ?? []).flatMap((vote) => (vote.voter ? [{ ...vote, voter: vote.voter }] : [])).map((vote): FeaturebaseVoter => ({ ...contactOf(vote.voter), type: kind(vote.voter), createdAt: vote.created })), cursor);
        },
        comments: async (cursor) => {
          const body = await post<Cursored<"items", CannyComment>>("v2/comments/list", { limit: 100, ...(cursor && { cursor }) });
          // Canny lists them newest first; each page oldest first, as the comments step reads within a page.
          return page(body, (body.items ?? []).map(commentOf).reverse(), cursor);
        },
        changelog: async (cursor, limit) => {
          // ponytail: Canny lists entries newest first and skips at most 1,000, so every page reads all of them (up
          // to 10,000) and takes its slice oldest first; read them once per import if a changelog grows that long.
          const { entries } = await post<{ entries: CannyEntry[] }>("v1/entries/list", { limit: 10_000, sort: "created" });
          const sorted = entries.sort((a, b) => Date.parse(entryDate(a) ?? "") - Date.parse(entryDate(b) ?? "") || a.id.localeCompare(b.id));
          const from = Number(cursor ?? 0);
          return { items: sorted.slice(from, from + limit).map(entryOf), next: from + limit < sorted.length ? String(from + limit) : null };
        },
      },
    };
  },
};
