import { marked } from "marked";

import type { FeaturebaseAuthor, FeaturebaseChangelog, FeaturebaseComment, FeaturebaseContact, FeaturebasePost, FeaturebaseVoter, Page } from "../featurebase";
import { textHtml } from "./canny";
import type { ImportSourceDefinition } from "./index";

/**
 * Frill's API (v1), read-only, for imports (docs/plan.md, Import from Frill): GETs with the key as a Bearer token,
 * cursor pages (`after`, 100 at most). Its address is FRILL_API_URL, so tests point it at the fake (@tuti/testkit);
 * Frill itself otherwise.
 */

const FRILL_URL = "https://api.frill.co/v1";

/** Frill answered with an error (`status`), or couldn't be reached or read (0). */
export class FrillError extends Error {
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
const UNREACHABLE = "Frill couldn't be reached.";

type Query = Record<string, string | number | null | undefined>;

/**
 * A client for one API key. What fails for a while (429, 5xx, no answer) is tried again, after Retry-After or 0.5s
 * doubling up to 8s; nothing starts, nor waits to be tried again, past `deadline` (epoch ms). `wait` is how it sleeps
 * between tries (tests skip it).
 */
export function frill(key: string, deadline: number, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const base = (process.env.FRILL_API_URL || FRILL_URL).replace(/\/$/, "");
  return async function get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(`${base}/${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    let last: FrillError | null = null;
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline) {
        throw last ?? new FrillError(0, UNREACHABLE);
      }
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        if (response.ok) {
          return (await response.json()) as T;
        }
      } catch {
        // No answer, or one cut off: tried again.
        response = null;
      }
      const message = response && ((await response.json().catch(() => null)) as { message?: unknown } | null)?.message;
      const text = typeof message === "string" ? message : response ? `Frill answered ${response.status}` : UNREACHABLE;
      // A missing or wrong key: a refusal (401), whichever 4xx says so.
      const status = response ? (response.status < 500 && /api.?key|unauthen/i.test(text) ? 401 : response.status) : 0;
      const error = new FrillError(status, text);
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

/** Null for a record Frill no longer has (it answers 400 or 404 for an idx it doesn't know). */
const unlessGone = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (error instanceof FrillError && (error.status === 400 || error.status === 404)) {
      return null;
    }
    throw error;
  });

/** Someone as Frill names them on an idea, comment or vote: no email there (the followers' list has it). */
type FrillPerson = { idx: string; name?: string | null; avatar?: string | null };
type FrillFollower = FrillPerson & { email?: string | null; created_at?: string | null };
type FrillAttachment = { url?: string | null; type?: string | null };
type FrillIdea = {
  idx: string;
  name?: string | null;
  description?: string | null;
  content_html?: string | null;
  comment_count?: number;
  note_count?: number;
  is_archived?: boolean;
  is_completed?: boolean;
  is_bug?: boolean;
  /** Not in Frill's reference, but its dashboard can mark an idea private: read if it's sent. */
  is_private?: boolean;
  approval_status?: "approved" | "needs-approval" | "rejected" | null;
  created_at: string;
  updated_at?: string | null;
  author?: FrillPerson | null;
  status?: { idx: string; name?: string | null } | null;
  attachments?: FrillAttachment[] | null;
};
type FrillComment = {
  idx: string;
  message?: string | null;
  content_html?: string | null;
  /** A note: the team's alone. */
  is_private?: boolean;
  created_at: string;
  follower?: FrillPerson | null;
  attachments?: FrillAttachment[] | null;
};
type FrillAnnouncement = {
  idx: string;
  name?: string | null;
  /** Markdown. */
  content?: string | null;
  content_html?: string | null;
  is_published?: boolean;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  categories?: { idx: string; name: string }[] | null;
  ideas?: { idx: string }[] | null;
};
/** Its docs give both `endCursor` and `after` as the next page's cursor. */
type Listed<T> = { data: T[]; pagination?: { hasNextPage?: boolean; endCursor?: string | null; after?: string | null } | null };

/** A list's next cursor: null at the end, or when it doesn't move. */
function nextOf(body: Listed<unknown>, cursor: string | null): string | null {
  const next = body.pagination?.endCursor ?? body.pagination?.after ?? null;
  return body.pagination?.hasNextPage !== false && body.data.length > 0 && next && next !== cursor ? next : null;
}

/**
 * Frill's API says nothing that proves an address (no id in the team's app, no verified flag): every follower is a
 * lead, never matched to someone here by it.
 */
const contactOf = (follower: FrillFollower): FeaturebaseContact => ({ id: follower.idx, type: "lead", email: follower.email, name: follower.name, profilePicture: follower.avatar });

const authorOf = (person: FrillPerson | null | undefined, type: "admin" | "lead" = "lead"): FeaturebaseAuthor => (person ? { id: person.idx, name: person.name, type } : null);

/** Its HTML (else its plain text), and the images attached to it that it doesn't show already. */
function htmlOf(html: string | null | undefined, text: string | null | undefined, attachments: FrillAttachment[] | null | undefined): string {
  const body = html?.trim() ? html : textHtml(text, []);
  const images = (attachments ?? []).flatMap((file) => (file.url && file.type?.startsWith("image/") && !body.includes(file.url) ? [file.url] : []));
  return body + textHtml("", images);
}

/** Frill's statuses are the team's own: Tuti's by their words, from a word's start ("Incomplete" isn't done; postStatus reads its own names first), else Open. */
const STATUS_WORDS: [RegExp, FeaturebasePost["status"]["type"]][] = [
  [/\b(clos|declin|reject|won.?t|not planned)/i, "canceled"],
  [/\b(complet|shipped|done|released|launched)/i, "completed"],
  [/\b(progress|develop|building|working)/i, "active"],
  [/\b(plan|next|soon)/i, "unstarted"],
  [/\b(review|consider|evaluat)/i, "reviewing"],
];
const statusOf = (idea: FrillIdea): FeaturebasePost["status"] => {
  const name = idea.status?.name ?? "";
  const type = idea.is_completed ? "completed" : STATUS_WORDS.find(([words]) => words.test(name))?.[1];
  return { name: idea.is_completed ? "completed" : name, type } as FeaturebasePost["status"];
};

/** One board: Frill's API lists no boards, so every idea is in it. */
const BOARD = "frill";

const postOf = (idea: FrillIdea): FeaturebasePost => ({
  id: idea.idx,
  title: idea.name ?? "",
  content: htmlOf(idea.content_html, idea.description, idea.attachments),
  boardId: BOARD,
  status: statusOf(idea),
  author: authorOf(idea.author),
  createdAt: idea.created_at,
  updatedAt: idea.updated_at ?? idea.created_at,
  eta: null,
  // Waiting for the team's approval: left out, as Featurebase's in review.
  inReview: idea.approval_status === "needs-approval",
  // Rejected or archived: off Frill's board.
  portalHidden: idea.approval_status === "rejected" || Boolean(idea.is_archived),
  // Private, or a bug (Frill keeps bugs off the board): only its author and the team, as Private here (one without an
  // author is left out).
  access: idea.is_private || idea.is_bug ? { userIds: [idea.author?.idx ?? ""] } : null,
});

/** On `ideaId`: Frill's comment names its idea only by a number of its own. Notes are the team's, so their author is the team's. */
const commentOf = (comment: FrillComment, ideaId: string): FeaturebaseComment => ({
  id: comment.idx,
  content: htmlOf(comment.content_html, comment.message, comment.attachments),
  postId: ideaId,
  author: authorOf(comment.follower, comment.is_private ? "admin" : "lead"),
  createdAt: comment.created_at,
  isPrivate: Boolean(comment.is_private),
  inReview: false,
  isSpam: false,
  isDeleted: false,
});

/** When an announcement is dated: published (or to be), else made. */
const announcementDate = (entry: FrillAnnouncement) => entry.published_at ?? entry.created_at ?? null;

const entryOf = (entry: FrillAnnouncement): FeaturebaseChangelog => ({
  id: entry.idx,
  title: entry.name,
  content: entry.content_html?.trim() ? entry.content_html : marked.parse(entry.content ?? "", { async: false }),
  date: announcementDate(entry),
  // One scheduled for later comes as a draft, to publish here.
  state: entry.is_published && entry.published_at && Date.parse(entry.published_at) <= Date.now() ? "live" : "draft",
  categories: (entry.categories ?? []).map((category) => ({ id: category.idx, name: category.name })),
  postIds: (entry.ideas ?? []).map((idea) => idea.idx),
  createdAt: entry.created_at,
  updatedAt: entry.updated_at,
});

export const frillSource: ImportSourceDefinition = {
  name: "Frill",
  credential: "key",
  status: (error) => (error instanceof FrillError ? error.status : null),
  connect: (key, { deadline }) => {
    const get = frill(key, deadline);
    // Ideas oldest first, a page at a time; the last page read is kept, as the comments are read idea by idea.
    let read: { cursor: string | null; page: Listed<FrillIdea> } | null = null;
    const ideas = async (cursor: string | null) => {
      if (read?.cursor !== cursor) {
        read = { cursor, page: await get<Listed<FrillIdea>>("ideas", { sortBy: "created_at", sort: "ASC", limit: 100, after: cursor }) };
      }
      return read.page;
    };
    let announcements: FrillAnnouncement[] | null = null;
    return {
      checkCredential: () => get("statuses", { limit: 1 }),
      checks: {
        contacts: () => get("followers", { limit: 1 }),
        feedback: () => get("ideas", { limit: 1 }),
        changelog: () => get("announcements", { limit: 1 }),
        // It reads only what's here: nothing to check.
        avatars: async () => undefined,
      },
      read: {
        // Frill's API lists no team: authors are named on what they wrote (without their address), which is all
        // adminMember needs. So there's no Team part either.
        admins: async () => [],
        contacts: async (cursor) => {
          const body = await get<Listed<FrillFollower>>("followers", { limit: 100, after: cursor });
          return { items: body.data.map(contactOf), next: nextOf(body, cursor) };
        },
        // Frill reads a follower only by their address, not their idx: one the list missed is someone by their name.
        contact: async () => null,
        boards: async () => [{ id: BOARD, name: "Feature requests" }],
        posts: async (cursor) => {
          const body = await ideas(cursor);
          return { items: body.data.map(postOf), next: nextOf(body, cursor) };
        },
        voters: async (postId, cursor) => {
          const body = await unlessGone(get<Listed<{ created_at?: string | null; voter?: FrillPerson | null }>>("votes", { idea_idx: postId, limit: 100, after: cursor }));
          // Frill keeps when each vote was cast: that's its date (votesPage dates none before its post).
          return (
            body && {
              items: body.data.flatMap((vote): FeaturebaseVoter[] => (vote.voter ? [{ id: vote.voter.idx, name: vote.voter.name, profilePicture: vote.voter.avatar, type: "lead", createdAt: vote.created_at }] : [])),
              next: nextOf(body, cursor),
            }
          );
        },
        // Frill lists comments only by idea: a page is one idea's (oldest first), the cursor where it got to: the ideas'
        // page, the idea (by idx and date: one gone since, the next by date) and its comments' cursor, as an array (the
        // comments step reads a cursor `{…}` as its own).
        comments: async (cursor) => {
          let [at, idx, made, after] = (cursor ? JSON.parse(cursor) : [null, null, null, null]) as [string | null, string | null, string | null, string | null];
          for (;;) {
            const page = await ideas(at);
            const found = idx ? page.data.findIndex((idea) => idea.idx === idx) : 0;
            let i = found >= 0 ? found : page.data.findIndex((idea) => idea.created_at > made!);
            if (found < 0) {
              after = null;
            }
            // Those Frill says have none aren't asked.
            while (i >= 0 && !after && page.data[i]?.comment_count === 0 && page.data[i]?.note_count === 0) {
              i++;
            }
            const idea = i >= 0 ? page.data[i] : undefined;
            const following = nextOf(page, at);
            if (!idea) {
              if (!following) {
                return { items: [], next: null };
              }
              [at, idx, made, after] = [following, null, null, null];
              continue;
            }
            const body = await unlessGone(get<Listed<FrillComment>>("comments", { idea_idx: idea.idx, included_types: "comments,notes", limit: 100, after }));
            const items = (body?.data ?? []).map((comment) => commentOf(comment, idea.idx)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
            const more = body && nextOf(body, after);
            const then = page.data[i + 1];
            const next = more ? [at, idea.idx, idea.created_at, more] : then ? [at, then.idx, then.created_at, null] : following ? [following, null, null, null] : null;
            return { items, next: next && JSON.stringify(next) };
          }
        },
        changelog: async (cursor, limit) => {
          // ponytail: Frill's order isn't documented, so every announcement is read once per connection and sorted
          // oldest first; read them by date range (published_after) if a changelog grows to thousands.
          if (!announcements) {
            const all: FrillAnnouncement[] = [];
            for (let after: string | null = null; ; ) {
              const body: Listed<FrillAnnouncement> = await get<Listed<FrillAnnouncement>>("announcements", { limit: 100, after });
              all.push(...body.data);
              after = nextOf(body, after);
              if (!after) {
                break;
              }
            }
            announcements = all.sort((a, b) => Date.parse(announcementDate(a) ?? "") - Date.parse(announcementDate(b) ?? "") || a.idx.localeCompare(b.idx));
          }
          const from = Number(cursor ?? 0);
          return { items: announcements.slice(from, from + limit).map(entryOf), next: from + limit < announcements.length ? String(from + limit) : null };
        },
      },
    };
  },
};
