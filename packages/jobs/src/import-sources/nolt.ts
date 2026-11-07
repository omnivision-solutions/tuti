import type { FeaturebaseAuthor, FeaturebaseBoard, FeaturebaseComment, FeaturebaseContact, FeaturebasePost, FeaturebaseVoter, Page } from "../featurebase";
import { textHtml } from "./canny";
import type { ImportSourceDefinition } from "./index";

/**
 * Nolt's public API, read-only, for imports (docs/plan.md, Import from Nolt): GraphQL, every request a POST with the
 * key in an `apikey` header, scoped to the key's one board. Its address is NOLT_API_URL, so tests point it at the fake
 * (@tuti/testkit); Nolt itself otherwise.
 */

const NOLT_URL = "https://api.nolt.io/api/v1/graphql";

/** Nolt answered with an error (`status`), or couldn't be reached or read (0). */
export class NoltError extends Error {
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
const UNREACHABLE = "Nolt couldn't be reached.";

/** Nolt takes 60 requests a minute per key: one a second keeps under it. NOLT_REQUEST_INTERVAL_MS changes it (the fake's 0). */
const interval = () => Number(process.env.NOLT_REQUEST_INTERVAL_MS ?? 1000);
// ponytail: one pace for the process (each page's step connects again); per key if a worker runs several Nolt imports at once.
let nextAt = 0;
/** Tests start each from a still pace. */
export const resetNoltPace = () => void (nextAt = 0);

/** GraphQL error codes as HTTP statuses. */
const CODES: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMIT_EXCEEDED: 429, BAD_REQUEST: 400, BAD_USER_INPUT: 400, GRAPHQL_VALIDATION_FAILED: 400 };

type GraphqlBody = { data?: Record<string, unknown> | null; errors?: { message?: string; extensions?: { code?: string } }[] };

/** What Nolt's answer says went wrong, as a status: a key it refuses is 401 however it says so. */
function failure(httpStatus: number, body: GraphqlBody | null): NoltError {
  const error = body?.errors?.[0];
  const message = error?.message ?? `Nolt answered ${httpStatus}`;
  // Nolt answers a key it doesn't know with a 500 from its own code (seen on its API): a refusal, as "Invalid Api Key" is.
  const refused = /api ?key/i.test(message) || /reading 'find'/.test(message);
  const status = refused ? 401 : (CODES[error?.extensions?.code ?? ""] ?? (/not found|invalid post id/i.test(message) ? 404 : httpStatus >= 400 ? httpStatus : 500));
  return new NoltError(status, message);
}

/**
 * A client for one API key. What fails for a while (429, 5xx, no answer) is tried again, after Retry-After or 0.5s
 * doubling up to 8s; nothing starts, nor waits to be tried again, past `deadline` (epoch ms). `wait` is how it sleeps.
 */
export function nolt(key: string, deadline: number, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const url = process.env.NOLT_API_URL || NOLT_URL;
  return async function query<T>(operation: string, text: string, variables: Record<string, unknown> = {}): Promise<T> {
    let last: NoltError | null = null;
    for (let attempt = 0; ; attempt++) {
      const pace = nextAt - Date.now();
      nextAt = Math.max(nextAt, Date.now()) + interval();
      if (pace > 0) {
        await wait(pace);
      }
      if (Date.now() >= deadline) {
        throw last ?? new NoltError(0, UNREACHABLE);
      }
      let response: Response | null = null;
      let body: GraphqlBody | null = null;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", apikey: key },
          body: JSON.stringify({ operationName: operation, query: text, variables }),
          signal: AbortSignal.timeout(Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()))),
        });
        body = (await response.json().catch(() => null)) as GraphqlBody | null;
        if (response.ok && body?.data && !body.errors?.length) {
          return body.data as T;
        }
      } catch {
        // No answer, or one cut off: tried again.
        response = null;
      }
      const error = response ? failure(response.status, body) : new NoltError(0, UNREACHABLE);
      if ((error.status === 0 || error.status === 429 || error.status >= 500) && attempt < RETRIES) {
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

/** A Nolt user: only one who signed in through the team's app (SSO) has an id; anyone else has an address at most. */
type NoltUser = { ssoId?: string | null; name?: string | null; email?: string | null; image?: string | null };
type NoltComment = {
  id: string;
  text?: string | null;
  type?: string | null;
  dateCreated: string;
  moderationStatus?: string | null;
  files?: { url?: string | null }[] | null;
  user?: NoltUser | null;
};
type Paged<T> = { nodes: (T | null)[]; hasMore: boolean; cursor?: string | null };
type NoltPost = {
  id: string;
  title?: string | null;
  statusId?: string | null;
  dateCreated: string;
  dateCompleted?: string | null;
  moderationStatus?: string | null;
  comments: Paged<NoltComment>;
};
type NoltStatus = { id: string; name: string; type: string };

const USER = "ssoId name email image";
const COMMENT = `id text type dateCreated moderationStatus files { url } user { ${USER} }`;
const POSTS = `query NoltPosts($cursor: String) { posts(cursor: $cursor, limit: 50, sort: NEWEST) { nodes { id title statusId dateCreated dateCompleted moderationStatus comments { nodes { ${COMMENT} } hasMore cursor } } hasMore cursor } }`;
const COMMENTS = `query NoltComments($id: String!, $cursor: String) { post(id: $id) { comments(cursor: $cursor) { nodes { ${COMMENT} } hasMore cursor } } }`;
const VOTES = `query NoltVotes($id: String!, $cursor: String) { post(id: $id) { votes(cursor: $cursor, limit: 50) { nodes { type user { ${USER} } } hasMore cursor } } }`;

/** A post Nolt no longer has (deleted since its list was read) reads as null. */
const unlessGone = <T>(read: Promise<{ post: T | null }>): Promise<{ post: T | null }> =>
  read.catch((error: unknown) => {
    if (error instanceof NoltError && error.status === 404) {
      return { post: null };
    }
    throw error;
  });

/** Their id here: their id in the team's app, else their address (null: neither, someone of their own). */
const idOf = (user: NoltUser) => user.ssoId?.trim() || user.email?.trim().toLowerCase() || null;

const contactOf = (user: NoltUser, id: string): FeaturebaseContact => ({
  id,
  userId: user.ssoId,
  // Only someone with an id in the team's app is a proven customer; an address alone is as unproven as a lead's.
  type: user.ssoId?.trim() ? "customer" : "lead",
  email: user.email,
  name: user.name,
  profilePicture: user.image,
});

/** Nolt's API doesn't say who's on the team: everyone comes as the user they are there; one without an id as a guest. */
function authorOf(user: NoltUser | null | undefined): FeaturebaseAuthor {
  if (!user) {
    return null;
  }
  const id = idOf(user);
  return { id, name: user.name, email: user.email, type: id ? (user.ssoId?.trim() ? "customer" : "lead") : "guest" };
}

/** Waiting for the team's moderation there (pending, flagged): not public yet. */
const held = (status: string | null | undefined) => status === "PENDING" || status === "FLAGGED";

/** A post's own text is its first comment (Nolt's posts are made with one): the earliest a person wrote. */
const firstOf = (comments: NoltComment[]) =>
  comments.filter((comment) => (comment.type ?? "BASIC") === "BASIC").sort((a, b) => a.dateCreated.localeCompare(b.dateCreated))[0] ?? null;

/** Nolt's system statuses by their value, as Tuti's names (postStatus reads them); the team's own by their name. */
const SYSTEM: Record<string, string> = { OPEN: "open", UNASSIGNED: "open", PLANNED: "planned", IN_PROGRESS: "in progress", COMPLETED: "completed", ARCHIVED: "closed", CLOSED: "closed", MERGED: "closed" };
function statusName(statusId: string | null | undefined, statuses: Map<string, NoltStatus>): string {
  const status = statusId ? statuses.get(statusId) : undefined;
  if (!status) {
    return SYSTEM[statusId ?? ""] ?? "open";
  }
  return status.type === "CUSTOM" ? status.name : (SYSTEM[status.type] ?? "open");
}

/** A comments page asks for at most `commentRequests` posts' further comments (past their first chunk), at one a second. */
export const NOLT_PAGE = { commentRequests: 30 };

const present = <T>(nodes: (T | null)[]) => nodes.flatMap((node) => (node ? [node] : []));
const urls = (comment: NoltComment) => comment.files?.flatMap((file) => (file.url ? [file.url] : []));

export const noltSource: ImportSourceDefinition = {
  name: "Nolt",
  credential: "key",
  status: (error) => (error instanceof NoltError ? error.status : null),
  connect: (key, { deadline }) => {
    const query = nolt(key, deadline);
    const board = () => query<{ board: { id: string; name: string } }>("NoltBoard", "query NoltBoard { board { id name } }");
    // The key's one board, read once a page: its posts carry its id.
    let theBoard: ReturnType<typeof board> | null = null;
    const boardOnce = () => (theBoard ??= board());
    // Its users, read once a page too: every unknown author or voter is looked up among them.
    let theUsers: Promise<NoltUser[]> | null = null;
    const users = () => (theUsers ??= query<{ users: NoltUser[] | null }>("NoltUsers", `query NoltUsers { users { ${USER} } }`).then((body) => body.users ?? []));

    /**
     * Every post, oldest first, with its first chunk of comments (the first of them its own text). ponytail: Nolt lists
     * posts newest first, so every page reads them all, a request per 50; a cursor of Nolt's own once boards grow past
     * a few thousand posts.
     */
    async function allPosts() {
      const posts: NoltPost[] = [];
      let cursor: string | null = null;
      do {
        const { posts: page }: { posts: Paged<NoltPost> } = await query("NoltPosts", POSTS, { cursor });
        posts.push(...present(page.nodes));
        cursor = page.hasMore && page.cursor !== cursor ? (page.cursor ?? null) : null;
      } while (cursor);
      return posts.sort((a, b) => a.dateCreated.localeCompare(b.dateCreated) || a.id.localeCompare(b.id));
    }

    return {
      checkCredential: board,
      checks: {
        contacts: users,
        feedback: () => query("NoltPosts", POSTS, { cursor: null }),
        // It reads only what's here: nothing to check.
        avatars: async () => undefined,
      },
      read: {
        // Nolt's team list has no names or addresses: there's no Team part, and the team's posts come under their names.
        admins: async () => [],
        contacts: async () => ({
          items: (await users()).flatMap((user) => {
            const id = idOf(user);
            return id ? [contactOf(user, id)] : [];
          }),
          next: null,
        }),
        contact: async (id) => {
          const user = (await users()).find((u) => idOf(u) === id);
          return user ? contactOf(user, id) : null;
        },
        boards: async () => {
          const { board: one } = await boardOnce();
          // Nolt's API doesn't say whether the board is public: it comes turned off (the team's alone, off the portal),
          // its posts as the board's, for the team to turn on once they've checked.
          return [{ id: one.id, name: one.name, off: true } satisfies FeaturebaseBoard];
        },
        posts: async () => {
          const { listStatuses } = await query<{ listStatuses: NoltStatus[] }>("NoltStatuses", "query NoltStatuses { listStatuses { id name type } }");
          const statuses = new Map(listStatuses.map((status) => [status.id, status]));
          const boardId = (await boardOnce()).board.id;
          const items = (await allPosts()).map((post): FeaturebasePost => {
            const first = firstOf(present(post.comments.nodes));
            return {
              id: post.id,
              title: post.title ?? "",
              content: first ? textHtml(first.text, urls(first)) : "",
              boardId,
              status: { name: statusName(post.statusId, statuses) } as FeaturebasePost["status"],
              author: authorOf(first?.user),
              createdAt: post.dateCreated,
              updatedAt: post.dateCompleted ?? post.dateCreated,
              eta: null,
              inReview: held(post.moderationStatus),
              portalHidden: post.moderationStatus === "REJECTED",
            };
          });
          return { items, next: null };
        },
        voters: async (postId, cursor) => {
          const { post } = await unlessGone(query<{ post: { votes: Paged<{ type?: string | null; user?: NoltUser | null }> | null } | null }>("NoltVotes", VOTES, { id: postId, cursor }));
          if (!post) {
            return null;
          }
          // Only upvotes, by someone it names (votes come only while the board's voters are public); Nolt keeps no vote's date.
          const items = (post.votes?.nodes ?? []).flatMap((vote): FeaturebaseVoter[] => {
            const id = vote?.type === "UP" && vote.user ? idOf(vote.user) : null;
            const contact = id && contactOf(vote!.user!, id);
            return contact ? [{ ...contact, type: contact.type as FeaturebaseVoter["type"] }] : [];
          });
          return { items, next: post.votes?.hasMore && post.votes.cursor && post.votes.cursor !== cursor ? post.votes.cursor : null };
        },
        /**
         * The comments of the posts from the cursor's (oldest first) on, as far as NOLT_PAGE.commentRequests reach. The
         * cursor names that post (`<date>|<id>`; never `{…`, which the comments step reads as its own), so one deleted
         * before it moves nothing: one deleted itself, from the next after it.
         */
        comments: async (cursor): Promise<Page<FeaturebaseComment>> => {
          const posts = await allPosts();
          const after = cursor ? { date: cursor.slice(0, cursor.indexOf("|")), id: cursor.slice(cursor.indexOf("|") + 1) } : null;
          const from = after ? posts.findIndex((post) => post.id === after.id || post.dateCreated.localeCompare(after.date) > 0 || (post.dateCreated === after.date && post.id.localeCompare(after.id) > 0)) : 0;
          if (from < 0) {
            return { items: [], next: null };
          }
          const items: FeaturebaseComment[] = [];
          let requests = 0;
          let at = from;
          for (; at < posts.length; at++) {
            const post = posts[at]!;
            const chunk = present(post.comments.nodes);
            if (post.comments.hasMore && requests >= NOLT_PAGE.commentRequests && at > from) {
              break;
            }
            const all = [...chunk];
            let more = post.comments.hasMore ? (post.comments.cursor ?? null) : null;
            while (more) {
              // Null: deleted in Nolt since the list was read; what its first chunk had is all there is.
              const { post: read } = await unlessGone(query<{ post: { comments: Paged<NoltComment> } | null }>("NoltComments", COMMENTS, { id: post.id, cursor: more }));
              requests++;
              all.push(...present(read?.comments.nodes ?? []));
              more = read?.comments.hasMore && read.comments.cursor !== more ? (read.comments.cursor ?? null) : null;
            }
            const first = firstOf(chunk);
            // Its first is the post's own text; the others Nolt writes itself (status changes, merges, locks) aren't anyone's.
            items.push(
              ...all
                .filter((comment) => comment.id !== first?.id && (comment.type ?? "BASIC") === "BASIC")
                .map((comment): FeaturebaseComment => ({
                  id: comment.id,
                  content: textHtml(comment.text, urls(comment)),
                  postId: post.id,
                  author: authorOf(comment.user),
                  createdAt: comment.dateCreated,
                  isPrivate: false,
                  inReview: held(comment.moderationStatus),
                  isSpam: comment.moderationStatus === "REJECTED",
                  isDeleted: false,
                })),
            );
          }
          items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          const next = posts[at];
          return { items, next: next ? `${next.dateCreated}|${next.id}` : null };
        },
      },
    };
  },
};
