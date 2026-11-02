import { type PostStatus, Prisma, prisma } from "@tuti/db";
import { audienceReach, postAudience } from "@tuti/jobs";
import { TYPING_SUGGESTION_MIN_SIMILARITY } from "@tuti/shared";

import type { GroupCondition } from "@/lib/group-conditions";
import { ACTIVE_STATUSES, POSTS_PER_PAGE, type PostFilters, type Sort } from "@/lib/post-filters";
import { inGroupSql } from "@/server/group-conditions-sql";

/** Pending suggestions that this post duplicates an older post that's still listed. */
export const possibleDuplicateOf = { status: "PENDING", original: { duplicateOfId: null } } as const;

/** The most posts one request lists: past it, each page more drops the top of the list. */
export const MAX_LISTED = 1000;

/**
 * The first `filters.page` pages of a list, and whether there are more after them. Its work is
 * bounded whatever `?page=` says: at most `MAX_LISTED` posts, the last ones of those pages.
 */
async function upToPage<T>(filters: PostFilters, find: (page: { skip: number; take: number }) => Promise<T[]>) {
  const end = filters.page * POSTS_PER_PAGE;
  const skip = Math.max(0, end - MAX_LISTED);
  const posts = await find({ skip, take: end - skip + 1 });
  return { posts: posts.slice(0, end - skip), more: posts.length > end - skip };
}

const teamPostSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  voteCount: true,
  commentCount: true,
  sample: true,
  board: { select: { slug: true, name: true } },
  author: { select: { name: true } },
  _count: { select: { duplicateSuggestions: { where: possibleDuplicateOf } } },
} satisfies Prisma.PostSelect;

/**
 * What Feedback's list narrows to besides the status: a board, words in the title or description,
 * possible duplicates only, posts a reader group voted for (its conditions).
 */
export type TeamPostScope = { board?: string; q?: string; duplicatesOnly?: boolean; group?: GroupCondition[] };

/**
 * A voter (`v`, a vote; `u`, its user) as the project's users (`s`): the one its SSO signed in as, or,
 * signed in another way, the ones with their address once it's verified (as readerOf). Identities'
 * emails are kept lowercase, so (projectId, email)'s index finds them.
 */
const voterIdentities = (projectId: string) => Prisma.sql`
  JOIN "user" u ON u.id = v."userId"
  JOIN sso_identity s ON s."projectId" = ${projectId}
    AND (s."userId" = v."userId" OR (u."emailVerified" AND s.email = lower(u.email)))
    -- The team votes as the team, not as one of the project's users (as readerOf).
    AND NOT EXISTS (SELECT 1 FROM team_member t WHERE t."projectId" = ${projectId} AND t."userId" = v."userId")`;

/** A post with a pending suggestion that it duplicates a post still listed. */
const possibleDuplicate = Prisma.sql`EXISTS (SELECT 1 FROM duplicate_suggestion d JOIN post o ON o.id = d."originalId"
  WHERE d."postId" = p.id AND d.status = 'PENDING' AND o."duplicateOfId" IS NULL)`;

/** The posts (`p`) `scope` takes, every status (a portal board's too). */
function teamPostFilter(projectId: string, { board, q, duplicatesOnly, group }: TeamPostScope): Prisma.Sql {
  // Each word in the title or the description, ILIKE's wildcards (and its escape) typed as themselves.
  const words = (q?.trim().split(/\s+/) ?? []).filter(Boolean).map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`);
  return Prisma.sql`p."projectId" = ${projectId} AND p."duplicateOfId" IS NULL
    ${board ? Prisma.sql`AND p."boardId" = (SELECT id FROM board WHERE "projectId" = ${projectId} AND slug = ${board})` : Prisma.empty}
    ${words.length > 0 ? Prisma.sql`AND ${Prisma.join(words.map((word) => Prisma.sql`(p.title ILIKE ${word} OR p.body ILIKE ${word})`), " AND ")}` : Prisma.empty}
    ${duplicatesOnly ? Prisma.sql`AND ${possibleDuplicate}` : Prisma.empty}
    ${
      group
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM vote v ${voterIdentities(projectId)} WHERE v."postId" = p.id AND ${inGroupSql(group, Prisma.sql`s`)})`
        : Prisma.empty
    }`;
}

const ORDER = {
  top: Prisma.sql`p."voteCount" DESC, p."createdAt" DESC, p.id DESC`,
  new: Prisma.sql`p."createdAt" DESC, p.id DESC`,
  // The most votes in the last 7 days, then the most votes.
  trending: Prisma.sql`COALESCE(r.recent, 0) DESC, p."voteCount" DESC, p."createdAt" DESC, p.id DESC`,
};

/**
 * A page of the ids of posts (`p`) `where` takes, in `sort`'s order, in SQL (Prisma can't filter by a
 * group's votes or order by this week's).
 */
async function pageIds(projectId: string, sort: Sort, where: Prisma.Sql, { skip, take }: { skip: number; take: number }) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM post p
    ${
      sort === "trending"
        ? Prisma.sql`LEFT JOIN (SELECT "postId", COUNT(*) AS recent FROM vote WHERE "projectId" = ${projectId} AND "createdAt" >= ${since} GROUP BY "postId") r ON r."postId" = p.id`
        : Prisma.empty
    }
    WHERE ${where}
    ORDER BY ${ORDER[sort]}
    OFFSET ${skip} LIMIT ${take}`;
  return rows.map((row) => row.id);
}

/** `posts` in the order of `ids`. */
function inOrder<T extends { id: string }>(ids: string[], posts: T[]) {
  const byId = new Map(posts.map((post) => [post.id, post]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The team's Feedback list: the page's ids, then their posts. */
export async function teamPosts(projectId: string, filters: PostFilters, scope: TeamPostScope = {}) {
  return upToPage(filters, async (page) => {
    const where = Prisma.sql`${teamPostFilter(projectId, scope)} ${filters.status ? Prisma.sql`AND p.status = ${filters.status}::"PostStatus"` : Prisma.empty}`;
    const ids = await pageIds(projectId, filters.sort, where, page);
    return inOrder(ids, await prisma.post.findMany({ where: { id: { in: ids } }, select: teamPostSelect }));
  });
}

/** Feedback's tab counts: posts in `scope` by status, the possible duplicates among them, and all of them. */
export async function teamPostCounts(projectId: string, scope: TeamPostScope) {
  const rows = await prisma.$queryRaw<{ status: PostStatus; posts: number; duplicates: number }[]>`
    SELECT p.status, COUNT(*)::int AS posts, (COUNT(*) FILTER (WHERE ${possibleDuplicate}))::int AS duplicates
    FROM post p WHERE ${teamPostFilter(projectId, { ...scope, duplicatesOnly: false })} GROUP BY p.status`;
  const sum = (count: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + count(row), 0);
  return { of: (status: PostStatus) => rows.find((row) => row.status === status)?.posts ?? 0, all: sum((row) => row.posts), duplicates: sum((row) => row.duplicates) };
}

/**
 * Who's asking: each post's total of `property` (a number property of the project's users) over its
 * voters: each voter as one of the project's users (their own identity, else the oldest with their
 * address), each of those once (two accounts can be the same user); posts with none aren't in it.
 */
export async function voterTotals(projectId: string, property: string | null, postIds: string[]): Promise<Map<string, number>> {
  if (!property || postIds.length === 0) {
    return new Map();
  }
  // As text: numbers JavaScript can hold may add up past what float8 can (then it's Infinity, not an error).
  const rows = await prisma.$queryRaw<{ postId: string; total: string }[]>`
    SELECT "postId", SUM((attributes ->> ${property}::text)::numeric)::text AS total FROM (
      SELECT DISTINCT ON ("postId", identity) "postId", attributes FROM (
        SELECT DISTINCT ON (v."postId", v."userId") v."postId", s.id AS identity, s.attributes
        FROM vote v ${voterIdentities(projectId)}
        WHERE v."postId" = ANY(${postIds})
        -- Their own identity first, then the oldest with their address.
        ORDER BY v."postId", v."userId", (s."userId" = v."userId") DESC, s."createdAt"
      ) voter
      ORDER BY "postId", identity
    ) asker
    WHERE jsonb_typeof(attributes -> ${property}::text) = 'number'
    GROUP BY "postId"`;
  return new Map(rows.map((row) => [row.postId, Number(row.total)]));
}

/** How many voters a post's sidebar lists; past them, "N more". */
export const VOTERS_SHOWN = 10;

/**
 * A post's voters for its sidebar: name, their `company` and `property`'s number (from their identity
 * in the project's app, as voterTotals finds it; none for the team or someone it doesn't know), the
 * biggest number first, then the latest vote.
 */
export function postVoters(projectId: string, property: string | null, postId: string) {
  return prisma.$queryRaw<{ userId: string; name: string; company: string | null; value: number | null }[]>`
    SELECT "userId", name, company, value::float8 AS value FROM (
      SELECT DISTINCT ON (v."userId") v."userId", u.name, v."createdAt",
        CASE WHEN jsonb_typeof(s.attributes -> 'company') = 'string' THEN s.attributes ->> 'company' END AS company,
        CASE WHEN ${property}::text IS NOT NULL AND jsonb_typeof(s.attributes -> ${property}::text) = 'number' THEN (s.attributes ->> ${property}::text)::numeric END AS value
      FROM vote v
      JOIN "user" u ON u.id = v."userId"
      LEFT JOIN sso_identity s ON s."projectId" = ${projectId}
        AND (s."userId" = v."userId" OR (u."emailVerified" AND s.email = lower(u.email)))
        AND NOT EXISTS (SELECT 1 FROM team_member t WHERE t."projectId" = ${projectId} AND t."userId" = v."userId")
      WHERE v."postId" = ${postId}
      -- Their own identity first, then the oldest with their address.
      ORDER BY v."userId", (s."userId" = v."userId") DESC NULLS LAST, s."createdAt"
    ) voter
    ORDER BY value DESC NULLS LAST, "createdAt" DESC, "userId"
    LIMIT ${VOTERS_SHOWN}`;
}

/** How many of a post's voters the team's reply emails with "Email voters" (who replyEmailed tells: postAudience); none on a sample post. */
export async function votersToEmail(projectId: string, postId: string) {
  const [project, votes] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, plan: true } }),
    prisma.vote.findMany({ where: { postId, post: { sample: false } }, select: { userId: true } }),
  ]);
  return (await postAudience(projectId, project, votes.map((vote) => vote.userId))).length;
}

/** Whether a project's email about a post (as the shipped one) reaches `userId`, or why not (audienceReach), for a portal board's Get updates. */
export async function emailReach(projectId: string, userId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, plan: true } });
  return (await audienceReach(projectId, project, [userId])).get(userId);
}

/** What shipped a post, for its sidebar: the Autopilot change that completed it (the latest, if it was completed again since), and the changelog entries listing it (drafts, then the latest published first). */
export async function howShipped(postId: string) {
  const [change, entries] = await Promise.all([
    // Only while it's completed: reopened by hand, it didn't ship after all (Undo marks the update undone).
    prisma.codeChangeAction.findFirst({
      where: { postId, kind: "RESOLVES", status: "APPLIED", post: { status: "COMPLETED" } },
      orderBy: { decidedAt: "desc" },
      select: { decidedAt: true, codeChange: { select: { id: true, repo: true, number: true } } },
    }),
    prisma.changelogEntryPost.findMany({
      where: { postId },
      // Drafts first, then the latest published.
      orderBy: [{ entry: { publishedAt: { sort: "desc", nulls: "first" } } }, { entry: { createdAt: "desc" } }],
      select: { entry: { select: { number: true, title: true, publishedAt: true } } },
    }),
  ]);
  // Reopened since (and completed again some other way): this completion isn't that change's.
  const reopened =
    change?.decidedAt && (await prisma.postEvent.count({ where: { postId, from: "COMPLETED", createdAt: { gt: change.decidedAt } } })) > 0;
  return { change: change && !reopened ? change.codeChange : null, entries: entries.map(({ entry }) => entry) };
}

/**
 * A portal board's posts in `statuses` (every status without them) with `q`'s words in the title or
 * description, with whether `userId` voted for each; `mine`: only those `userId` posted or voted for.
 */
export function boardPosts(
  board: { projectId: string; slug: string },
  filters: PostFilters,
  userId: string | undefined,
  { statuses, q, mine = false }: { statuses?: PostStatus[]; q?: string; mine?: boolean } = {},
) {
  return upToPage(filters, async (page) => {
    const where = Prisma.sql`${teamPostFilter(board.projectId, { board: board.slug, q })} ${statuses ? Prisma.sql`AND p.status = ANY(${statuses}::"PostStatus"[])` : Prisma.empty}
      ${mine ? Prisma.sql`AND (p."authorId" = ${userId ?? ""} OR EXISTS (SELECT 1 FROM vote v WHERE v."postId" = p.id AND v."userId" = ${userId ?? ""}))` : Prisma.empty}`;
    const ids = await pageIds(board.projectId, filters.sort, where, page);
    const posts = await prisma.post.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        status: true,
        voteCount: true,
        commentCount: true,
        sample: true,
        author: { select: { name: true } },
        votes: { where: { userId: userId ?? "" }, select: { userId: true } },
      },
    });
    return inOrder(ids, posts);
  });
}

/** A project's boards for a portal board's sidebar, oldest first (as the header's row), each with how many ideas on it aren't done yet. */
export function boardsWithCounts(projectId: string) {
  return prisma.board.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, name: true, _count: { select: { posts: { where: { duplicateOfId: null, status: { in: ACTIVE_STATUSES } } } } } },
  });
}

/** A board's completed posts, the latest completed first (as the roadmap's Completed: older ones by their last change), for its "Recently shipped" card. */
export function recentlyShipped(boardId: string) {
  return prisma.$queryRaw<{ id: string; number: number; title: string; voteCount: number }[]>`
    SELECT p.id, p.number, p.title, p."voteCount" FROM post p
    WHERE p."boardId" = ${boardId} AND p."duplicateOfId" IS NULL AND p.status = 'COMPLETED'
    ORDER BY COALESCE((SELECT MAX(e."createdAt") FROM post_event e WHERE e."postId" = p.id AND e."to" = 'COMPLETED'), p."updatedAt") DESC, p.id DESC
    LIMIT 5`;
}

type Like = { id: string; number: number; title: string; voteCount: number; status: PostStatus; sample: boolean; boardSlug: string };

/**
 * The project's posts (not merged ones, and as `where` narrows them) whose titles have the words of `title`, the likest
 * first. Only those of `sample`'s kind: sample content (server/sample-content.ts) never mixes with the team's.
 */
function postsTitledLike(projectId: string, title: string, sample: boolean, where: Prisma.Sql, limit: number) {
  return prisma.$queryRaw<Like[]>`
    SELECT p.id, p.number, p.title, p."voteCount", p.status, p.sample, b.slug AS "boardSlug"
    FROM post p
    JOIN board b ON b.id = p."boardId"
    WHERE p."projectId" = ${projectId} AND p."duplicateOfId" IS NULL AND p.sample = ${sample} ${where}
      AND (p.title % ${title} OR ${title} <% p.title)
    ORDER BY greatest(similarity(p.title, ${title}), word_similarity(${title}, p.title)) DESC, p."voteCount" DESC
    LIMIT ${limit}`;
}

/**
 * The open posts (not completed or closed) a conversation looks like, for "Looks related" beside it: by the words of
 * its subject, as postsLike matches a title (conversations have no embeddings). Not those it's linked to already. Up to 3.
 * Of its kind: a real conversation's are real posts, never sample ones.
 */
export function postsLikeConversation(projectId: string, conversation: { id: string; subject: string; sample: boolean }) {
  return postsTitledLike(
    projectId,
    conversation.subject,
    conversation.sample,
    Prisma.sql`AND p.status NOT IN ('COMPLETED', 'CLOSED')
      AND NOT EXISTS (SELECT 1 FROM conversation_post l WHERE l."conversationId" = ${conversation.id} AND l."postId" = p.id)`,
    3,
  );
}

/** How many similar posts a post's sidebar lists. */
const SIMILAR_SHOWN = 5;

/**
 * Posts like `post`, for its sidebar (and the first in "Merge into…"): by meaning, from the embeddings
 * kept for posts (no AI call to read a page), and by the words of its title (as findSimilarPosts
 * matches a typed one); found both ways first. Not merged ones, nor itself. `open`: only those still open
 * to votes (not completed or closed), for the portal's similar ideas. Only those of `sample`'s kind (by default the
 * post's): sample content (server/sample-content.ts) never mixes with the team's, in a sidebar, a merge or a portal.
 */
export async function postsLike(
  projectId: string,
  post: { id: string; title: string; sample: boolean },
  { open = false, sample = post.sample }: { open?: boolean; sample?: boolean } = {},
) {
  const status = open ? Prisma.sql`AND p.status NOT IN ('COMPLETED', 'CLOSED')` : Prisma.empty;
  const [byMeaning, byWords] = await Promise.all([
    prisma.$queryRaw<Like[]>`
      SELECT p.id, p.number, p.title, p."voteCount", p.status, p.sample, b.slug AS "boardSlug"
      FROM post_embedding mine
      JOIN post_embedding e ON e."projectId" = mine."projectId" AND e."postId" <> mine."postId"
      JOIN post p ON p.id = e."postId"
      JOIN board b ON b.id = p."boardId"
      -- The project's own posts only, whatever an embedding row says.
      WHERE mine."postId" = ${post.id} AND p."projectId" = ${projectId} AND p."duplicateOfId" IS NULL AND p.sample = ${sample} ${status}
        AND 1 - (e.embedding <=> mine.embedding) >= ${TYPING_SUGGESTION_MIN_SIMILARITY}
      ORDER BY e.embedding <=> mine.embedding
      LIMIT ${SIMILAR_SHOWN * 2}`,
    postsTitledLike(projectId, post.title, sample, Prisma.sql`AND p.id <> ${post.id} ${status}`, SIMILAR_SHOWN * 2),
  ]);
  // Each way's best twice over, so one found both ways but past the other's first five still ranks as found both ways.
  const both = new Set(byWords.map((p) => p.id).filter((id) => byMeaning.some((p) => p.id === id)));
  return [...byMeaning.filter((p) => both.has(p.id)), ...byMeaning.filter((p) => !both.has(p.id)), ...byWords.filter((p) => !both.has(p.id))].slice(0, SIMILAR_SHOWN);
}

/** The posts a post may be merged into (`candidates`), those like it (`like`, postsLike's, of its kind) first: the one it duplicates is likely among them. */
export function likeFirst<T extends { id: string }>(like: T[], candidates: T[]): T[] {
  return [...like, ...candidates.filter((candidate) => !like.some((post) => post.id === candidate.id))];
}

/** The posts either side of `number` among the project's, by number (not merged ones): the newer and the older. */
export async function postNeighbours(projectId: string, number: number) {
  const [newer, older] = await Promise.all([
    prisma.post.findFirst({ where: { projectId, duplicateOfId: null, number: { gt: number } }, orderBy: { number: "asc" }, select: { number: true } }),
    prisma.post.findFirst({ where: { projectId, duplicateOfId: null, number: { lt: number } }, orderBy: { number: "desc" }, select: { number: true } }),
  ]);
  return { newer: newer?.number ?? null, older: older?.number ?? null };
}

/**
 * The posts a "Link post…" picker offers for what's typed (`where` narrows them, e.g. by status): the one with that
 * number ("#12" or "12") first, then those with it in their title, the most voted first; with nothing typed, the
 * newest. Merged posts are left out. Up to 20.
 */
export async function searchPosts(projectId: string, q: string, where: Prisma.PostWhereInput = {}) {
  const query = String(q).trim().slice(0, 200);
  const scope = { ...where, projectId, duplicateOfId: null };
  const select = { id: true, number: true, title: true, voteCount: true, status: true } as const;
  if (!query) {
    return prisma.post.findMany({ where: scope, orderBy: { createdAt: "desc" }, take: 20, select });
  }
  // A number as posts have them (a 32-bit integer).
  const asNumber = /^#?\d{1,10}$/.test(query) ? Number(query.replace("#", "")) : null;
  const number = asNumber !== null && asNumber <= 2_147_483_647 ? asNumber : null;
  const [numbered, titled] = await Promise.all([
    number === null ? null : prisma.post.findFirst({ where: { ...scope, number }, select }),
    prisma.post.findMany({
      // Without a leading "#", as the picker matches titles; `contains` is a LIKE: its wildcards (and the escape) typed as themselves.
      where: { ...scope, title: { contains: query.replace(/^#/, "").replace(/[\\%_]/g, "\\$&"), mode: "insensitive" } },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
      take: 20,
      select,
    }),
  ]);
  return [...(numbered ? [numbered] : []), ...titled.filter((post) => post.id !== numbered?.id)].slice(0, 20);
}
