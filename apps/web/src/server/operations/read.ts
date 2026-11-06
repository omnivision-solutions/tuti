import { Prisma, prisma, type PostStatus } from "@tuti/db";
import { postSummary, postSummarySelect } from "@tuti/jobs";
import { z } from "zod";

import { postOrderBy } from "@/lib/post-filters";

import { displayDoc } from "../content";
import { portalAddress } from "../custom-domains";
import { actorReader } from "../portal-access";
import { actorPostViewer, canSeePost, type PostViewer, shownBoards, toApiVisibility, visiblePosts, visiblePostsSql } from "../post-visibility";
import { type Actor, defineOperation, OperationError } from "./define";
import { linkSelect, linkView } from "./link-view";

/** Statuses as the API spells them. */
export const STATUSES = ["open", "under_review", "planned", "in_progress", "completed", "closed"] as const;
export const toApiStatus = (status: PostStatus) => status.toLowerCase() as (typeof STATUSES)[number];
export const fromApiStatus = (status: (typeof STATUSES)[number]) => status.toUpperCase() as PostStatus;

export async function projectSlug(projectId: string) {
  return (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } })).slug;
}

/** The project's portal address (see portalAddress), for links to its posts and articles. */
export async function projectPortal(projectId: string) {
  return portalAddress(await projectSlug(projectId));
}

export const listBoards = defineOperation({
  name: "boards.list",
  summary: "List the project's boards",
  method: "GET",
  path: "/boards",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ actor, projectId }) => {
    // Those the caller sees, and the posts on them they see (post-visibility.ts).
    const viewer = await actorPostViewer(actor, projectId);
    const boards = await prisma.board.findMany({
      where: { projectId, ...shownBoards(viewer) },
      orderBy: { createdAt: "asc" },
      select: { slug: true, name: true, postVisibility: true, _count: { select: { posts: { where: { duplicateOfId: null, ...visiblePosts(viewer) } } } } },
    });
    return { boards: boards.map((b) => ({ slug: b.slug, name: b.name, posts: b._count.posts, postVisibility: toApiVisibility(b.postVisibility) })) };
  },
});

// The post shape is shared with the worker, whose webhook events use it too.
export { postSummarySelect } from "@tuti/jobs";
export const summary = postSummary;

export const listPosts = defineOperation({
  name: "posts.list",
  summary: "List posts, most voted or newest first; merged duplicates are left out",
  method: "GET",
  path: "/posts",
  scope: "read",
  access: "anyone",
  input: z.object({
    board: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    sort: z.enum(["top", "new"]).default("top"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { status: "planned", sort: "top", limit: 10 },
  run: async ({ actor, projectId }, input) => {
    // ponytail: offset cursors; switch to keyset pagination if projects get very large.
    const posts = await prisma.post.findMany({
      where: {
        projectId,
        duplicateOfId: null,
        ...visiblePosts(await actorPostViewer(actor, projectId)),
        ...(input.board && { board: { slug: input.board } }),
        ...(input.status && { status: fromApiStatus(input.status) }),
      },
      orderBy: postOrderBy(input.sort),
      skip: input.cursor,
      take: input.limit + 1,
      select: postSummarySelect,
    });
    const portal = await projectPortal(projectId);
    const more = posts.length > input.limit;
    return {
      posts: posts.slice(0, input.limit).map((post) => summary(post, portal)),
      nextCursor: more ? String(input.cursor + input.limit) : null,
    };
  },
});

export const postNumber = z.coerce.number().int().positive();

export async function findPost(projectId: string, number: number) {
  const post = await prisma.post.findUnique({
    where: { projectId_number: { projectId, number } },
    select: {
      ...postSummarySelect,
      id: true,
      body: true,
      content: true,
      sample: true,
      authorId: true,
      visibility: true,
      // The summary's board, and whether it's turned off (canSeePost).
      board: { select: { ...postSummarySelect.board.select, off: true } },
      duplicateOf: { select: { number: true, authorId: true, visibility: true, board: { select: { off: true } } } },
    },
  });
  if (!post) {
    throw new OperationError(404, "not_found", `There's no post #${number}`);
  }
  return post;
}

/**
 * findPost for a caller who may only see some posts (the "anyone" operations): one they may not see, or merged into one
 * they may not see, is as missing as one that isn't there (post-visibility.ts).
 */
export async function findVisiblePost(actor: Actor, projectId: string, number: number) {
  const [post, viewer] = await Promise.all([findPost(projectId, number), actorPostViewer(actor, projectId)]);
  if (!canSeePost(viewer, post) || (post.duplicateOf && !canSeePost(viewer, post.duplicateOf))) {
    throw new OperationError(404, "not_found", `There's no post #${number}`);
  }
  return post;
}

export const getPost = defineOperation({
  name: "posts.get",
  summary:
    "Get a post by its number, with its text and rich content and `eta`: the month the team expects it (the portal hides it once it has passed or the post is completed or closed); to the team, who looks after it (`owner`)",
  method: "GET",
  path: "/posts/{number}",
  scope: "read",
  access: "anyone",
  input: z.object({ number: postNumber }),
  run: async ({ actor, projectId }, { number }) => {
    const post = await findVisiblePost(actor, projectId, number);
    const [links, ofTeam] = await Promise.all([
      prisma.postLink.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" }, select: linkSelect }),
      actorReader(actor, projectId).then((reader) => reader === null),
    ]);
    // When it's expected, as the team set it (the portal leaves out a month that's passed); who looks after it, the team's to read.
    const planning = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: { eta: true, owner: { select: { name: true, email: true } } } });
    return {
      ...summary(post, await projectPortal(projectId)),
      body: post.body,
      content: displayDoc(post),
      mergedInto: post.duplicateOf?.number ?? null,
      links: links.map(linkView),
      eta: planning.eta?.toISOString().slice(0, 7) ?? null,
      ...(ofTeam && { owner: planning.owner }),
    };
  },
});

export const listComments = defineOperation({
  name: "comments.list",
  summary: "List a post's comments, oldest first: to the team (an API key, a team member) with its internal notes (`internal: true`)",
  method: "GET",
  path: "/posts/{number}/comments",
  scope: "read",
  access: "anyone",
  input: z.object({ number: postNumber }),
  run: async ({ actor, projectId }, { number }) => {
    const post = await findVisiblePost(actor, projectId, number);
    const ofTeam = (await actorReader(actor, projectId)) === null;
    const select = { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true } } } as const;
    const [comments, notes, team] = await Promise.all([
      prisma.comment.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" }, select: { ...select, asReader: true } }),
      ofTeam ? prisma.postNote.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" }, select }) : [],
      prisma.teamMember.findMany({ where: { projectId }, select: { userId: true } }),
    ]);
    const teamIds = new Set(team.map((m) => m.userId));
    return {
      // The team's notes between them, in order.
      comments: [...comments.map((c) => ({ ...c, internal: false })), ...notes.map((n) => ({ ...n, internal: true, asReader: false }))]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((c) => ({
          id: c.id,
          // A team member's comment written with a portal's session is a reader's (signedInAsReader).
          author: { name: c.author.name, team: teamIds.has(c.author.id) && !c.asReader },
          body: c.body,
          content: displayDoc(c),
          createdAt: c.createdAt.toISOString(),
          ...(c.internal && { internal: true }),
        })),
    };
  },
});

/** The roadmap's columns, in order: what's planned, being built, and done (newest first). */
export const ROADMAP = [
  { status: "PLANNED", key: "planned" },
  { status: "IN_PROGRESS", key: "inProgress" },
  { status: "COMPLETED", key: "completed" },
] as const satisfies readonly { status: PostStatus; key: string }[];

/**
 * Each column's posts: most voted first, except Completed (most recently finished first). Up to 50
 * each. The team's roadmap narrows to a board, and Completed to what finished in its last `completedDays`.
 */
export async function roadmapColumns(projectId: string, viewer: PostViewer, { board, completedDays }: { board?: string; completedDays?: number } = {}) {
  const select = { ...postSummarySelect, id: true, board: { select: { slug: true, name: true } } } as const;
  // Only the posts `viewer` may see (post-visibility.ts).
  const onBoard = { ...(board ? { board: { slug: board } } : {}), ...visiblePosts(viewer) };
  return Promise.all(
    ROADMAP.map(async ({ status }) => {
      if (status !== "COMPLETED") {
        return prisma.post.findMany({
          where: { projectId, status, duplicateOfId: null, ...onBoard },
          orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
          take: 50,
          select,
        });
      }
      // When each was completed: its activity's latest Completed, or for one completed before status
      // changes were kept, its last change. Ordered by it, and with `completedDays`, only that recent.
      const completedAt = Prisma.sql`COALESCE((SELECT MAX(e."createdAt") FROM post_event e WHERE e."postId" = p.id AND e."to" = 'COMPLETED'), p."updatedAt")`;
      const since = completedDays ? new Date(Date.now() - completedDays * 86_400_000) : null;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM post p
        WHERE p."projectId" = ${projectId} AND p.status = 'COMPLETED' AND p."duplicateOfId" IS NULL AND ${visiblePostsSql(viewer)}
          ${board ? Prisma.sql`AND p."boardId" = (SELECT id FROM board WHERE "projectId" = ${projectId} AND slug = ${board})` : Prisma.empty}
          ${since ? Prisma.sql`AND ${completedAt} >= ${since}` : Prisma.empty}
        ORDER BY ${completedAt} DESC, p.id DESC
        LIMIT 50`;
      // Still Completed as they're read (one may have moved since the ids were).
      const posts = await prisma.post.findMany({ where: { id: { in: rows.map((row) => row.id) }, status: "COMPLETED", duplicateOfId: null, ...onBoard }, select });
      const byId = new Map(posts.map((post) => [post.id, post]));
      return rows.flatMap((row) => byId.get(row.id) ?? []);
    }),
  );
}

export const getRoadmap = defineOperation({
  name: "roadmap.get",
  summary: "The public roadmap: planned, in progress and completed posts",
  method: "GET",
  path: "/roadmap",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ actor, projectId }) => {
    const [columns, portal] = await Promise.all([roadmapColumns(projectId, await actorPostViewer(actor, projectId)), projectPortal(projectId)]);
    return Object.fromEntries(ROADMAP.map(({ key }, i) => [key, columns[i]!.map((post) => summary(post, portal))])) as Record<
      (typeof ROADMAP)[number]["key"],
      ReturnType<typeof summary>[]
    >;
  },
});
