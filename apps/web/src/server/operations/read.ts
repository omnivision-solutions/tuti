import { Prisma, prisma, type PostStatus } from "@tuti/db";
import { postSummary, postSummarySelect } from "@tuti/jobs";
import { z } from "zod";

import { COMMENT_SORTS, threads } from "@/lib/comment-threads";
import { postOrderBy } from "@/lib/post-filters";

import { displayDoc } from "../content";
import { portalAddress } from "../custom-domains";
import { actorReader } from "../portal-access";
import {
  actorPostViewer,
  canSeePost,
  type PostViewer,
  shownBoards,
  toApiVisibility,
  VISIBILITIES,
  visiblePosts,
  visiblePostsSql,
} from "../post-visibility";
import { actingUserId, type Actor, defineOperation, OperationError } from "./define";
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

/** A post's number, as an operation's input takes it (from the path, or a field). */
export const postNumber = z.coerce.number().int().positive();

/** Who sees a post besides the team, as the API's outputs say it. */
const visibilityOutput = z
  .enum(VISIBILITIES)
  .describe("Who sees it besides the team: everyone (public), its author (private), or nobody (team: Team only, or on a board turned off)")
  .meta({ examples: ["public"] });

/** A rich document (@tuti/content's format), as outputs give a post's or comment's text. */
export const docOutput = z
  .record(z.string(), z.unknown())
  .describe("Its text as a rich document (Tuti's content format, as the editor writes it: paragraphs, lists, images…)")
  .meta({ examples: [{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "The dashboard is too bright at night." }] }] }] });

const postTitle = z.string().describe("Its title").meta({ examples: ["Dark mode"] });
const postNumberOutput = z.number().int().describe("Its number in the project, which the API names it by").meta({ examples: [42] });

/** A post's fields as the API returns them (postSummary). */
export const postShape = {
  number: postNumberOutput,
  title: postTitle,
  status: z.enum(STATUSES).describe("Where it stands").meta({ examples: ["planned"] }),
  board: z.string().describe("The slug of the board it's on").meta({ examples: ["feature-requests"] }),
  votes: z.number().int().describe("How many vote for it (its author's own vote counts)").meta({ examples: [12] }),
  comments: z.number().int().describe("How many comments it has, the team's internal notes left out").meta({ examples: [3] }),
  author: z.object({ name: z.string().describe("Their name").meta({ examples: ["Sam"] }) }).describe("Who posted it"),
  visibility: visibilityOutput,
  createdAt: z.string().describe("When it was posted (ISO 8601)").meta({ examples: ["2026-11-03T09:24:00.000Z"] }),
  url: z.string().describe("Its page on the project's portal").meta({ examples: ["https://acme.example.com/feedback/feature-requests/dark-mode-42"] }),
};

export const postOutput = z.object(postShape).meta({ id: "Post", description: "A post: an idea or problem on a board, that people vote and comment on" });

/** A post named by its number and title (a possible duplicate's two). */
export const postRef = z.object({ number: postNumberOutput, title: postTitle });

export const listBoards = defineOperation({
  name: "boards.list",
  title: "List boards",
  summary: "List the project's boards the caller may see, oldest first, with how many posts each has",
  method: "GET",
  path: "/boards",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  output: z
    .object({
      boards: z
        .array(
          z
            .object({
              slug: z.string().describe("How the API names it: a post's `board`").meta({ examples: ["feature-requests"] }),
              name: z.string().describe("Its name on the portal").meta({ examples: ["Feature requests"] }),
              posts: z.number().int().describe("How many posts on it the caller may see, merged duplicates left out").meta({ examples: [24] }),
              postVisibility: z
                .enum(VISIBILITIES)
                .describe("Who sees a new post on it besides the team, unless the team says otherwise: everyone (public), its author (private), or nobody (team)")
                .meta({ examples: ["public"] }),
              off: z.boolean().describe("Turned off: the team's alone, off the portal (only the team and its keys see it)").meta({ examples: [false] }),
            })
            .meta({ id: "Board", description: "A board of posts" }),
        )
        .describe("The boards, oldest first: to the team (its keys, its members) every one, to others those on the portal"),
    })
    .describe("The project's boards"),
  run: async ({ actor, projectId }) => {
    // Those the caller sees, and the posts on them they see (post-visibility.ts).
    const viewer = await actorPostViewer(actor, projectId);
    const boards = await prisma.board.findMany({
      where: { projectId, ...shownBoards(viewer) },
      orderBy: { createdAt: "asc" },
      select: { slug: true, name: true, postVisibility: true, off: true, _count: { select: { posts: { where: { duplicateOfId: null, ...visiblePosts(viewer) } } } } },
    });
    // `off`: turned off, the team's alone (only the team and its keys see one).
    return { boards: boards.map((b) => ({ slug: b.slug, name: b.name, posts: b._count.posts, postVisibility: toApiVisibility(b.postVisibility), off: b.off })) };
  },
});

// The post shape is shared with the worker, whose webhook events use it too.
export { postSummarySelect } from "@tuti/jobs";
export const summary = postSummary;

export const listPosts = defineOperation({
  name: "posts.list",
  title: "List posts",
  summary: "List the posts the caller may see, a page at a time, most voted or newest first; merged duplicates are left out",
  method: "GET",
  path: "/posts",
  scope: "read",
  access: "anyone",
  input: z.object({
    board: z.string().optional().describe("Only the posts on this board, by its slug").meta({ examples: ["feature-requests"] }),
    status: z.enum(STATUSES).optional().describe("Only the posts with this status").meta({ examples: ["planned"] }),
    sort: z.enum(["top", "new"]).default("top").describe("`top`: most voted first (the default); `new`: newest first").meta({ examples: ["top"] }),
    limit: z.coerce.number().int().min(1).max(100).default(25).describe("How many to return, 1 to 100 (25 by default)").meta({ examples: [10] }),
    cursor: z.coerce.number().int().min(0).default(0).describe("Where the page starts: the previous page's `nextCursor`").meta({ examples: [25] }),
  }),
  output: z
    .object({
      posts: z.array(postOutput).describe("The page's posts, in the order asked for"),
      nextCursor: z.string().nullable().describe("Send it as `cursor` for the next page; null when there are no more").meta({ examples: ["25"] }),
    })
    .describe("A page of posts"),
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
  title: "Get a post",
  summary: "Get a post by its number, with its text, its links and when the team expects it",
  method: "GET",
  path: "/posts/{number}",
  scope: "read",
  access: "anyone",
  input: z.object({ number: postNumber.describe("The post's number").meta({ examples: [42] }) }),
  output: z
    .object({
      ...postShape,
      body: z.string().describe("Its text, as plain text").meta({ examples: ["The dashboard is too bright at night."] }),
      content: docOutput,
      mergedInto: z.number().int().nullable().describe("The number of the post it was merged into; null when it wasn't").meta({ examples: [null] }),
      links: z
        .array(
          z.object({
            id: z.string().describe("The link's id: links.remove takes it").meta({ examples: ["cm3k8x2qp0001ab12cd34ef56"] }),
            kind: z.enum(["pull_request", "issue", "release"]).describe("What it links to on GitHub").meta({ examples: ["pull_request"] }),
            repo: z.string().describe("The GitHub repository, as owner/name").meta({ examples: ["acme/app"] }),
            number: z.number().int().nullable().describe("The pull request's or issue's number; null for a release").meta({ examples: [128] }),
            tag: z.string().nullable().describe("The release's tag; null for a pull request or issue").meta({ examples: [null] }),
            url: z.string().describe("Its page on GitHub").meta({ examples: ["https://github.com/acme/app/pull/128"] }),
            title: z.string().nullable().describe("Its title on GitHub, when known").meta({ examples: ["Add a dark theme"] }),
            codeChange: z
              .string()
              .nullable()
              .describe("The code change whose applied action added it (codeChanges.get), if one did")
              .meta({ examples: [null] }),
          }),
        )
        .describe("The GitHub pull requests, issues and releases that work on or ship it, oldest first"),
      eta: z
        .string()
        .nullable()
        .describe("The month the team expects it, like 2026-12; null when not said. The portal hides it once it has passed or the post is completed or closed")
        .meta({ examples: ["2026-12"] }),
      owner: z
        .object({
          name: z.string().describe("Their name").meta({ examples: ["Olive Owner"] }),
          email: z.string().describe("Their email").meta({ examples: ["olive@example.com"] }),
        })
        .nullable()
        .optional()
        .describe("Who on the team looks after it; null for nobody. Only the team (its keys, its members) gets it"),
    })
    .describe("The post"),
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

/** A comment's fields that comments.create returns too. */
export const commentShape = {
  id: z.string().describe("The comment's id: comments.like and a reply's `replyTo` take it").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] }),
  author: z
    .object({
      name: z.string().describe("Their name").meta({ examples: ["Olive Owner"] }),
      team: z.boolean().describe("Whether they wrote it as the team: a team member, not signed in as a portal reader").meta({ examples: [true] }),
    })
    .describe("Who wrote it"),
  body: z.string().describe("Its text, as plain text").meta({ examples: ["Thanks! This is planned for next month."] }),
  content: docOutput,
  createdAt: z.string().describe("When it was written (ISO 8601)").meta({ examples: ["2026-11-04T14:02:00.000Z"] }),
};

const replyToOutput = z.string().nullable().describe("The id of the comment it replies to; null for one that replies to none").meta({ examples: [null] });
const internalOutput = z
  .literal(true)
  .optional()
  .describe("Only on an internal note, and `true`: only the team sees it, never on the portal, in emails or webhooks")
  .meta({ examples: [true] });

export const listComments = defineOperation({
  name: "comments.list",
  title: "List comments",
  summary: "List a post's comments, each followed by its replies; to the team (an API key, a team member), with its internal notes between them",
  method: "GET",
  path: "/posts/{number}/comments",
  scope: "read",
  access: "anyone",
  input: z.object({
    number: postNumber.describe("The post's number").meta({ examples: [42] }),
    sort: z
      .enum(COMMENT_SORTS)
      .default("oldest")
      .describe("Comments oldest first (the default) or newest first; each one's replies follow it, oldest first")
      .meta({ examples: ["newest"] }),
  }),
  output: z
    .object({
      comments: z
        .array(
          z
            .object({
              ...commentShape,
              replyTo: replyToOutput,
              likes: z.number().int().describe("How many like it").meta({ examples: [2] }),
              liked: z.boolean().describe("Whether the caller likes it (a key: its creator)").meta({ examples: [false] }),
              internal: internalOutput,
            })
            .meta({ id: "Comment", description: "A comment on a post, or a reply to one, or the team's internal note" }),
        )
        .describe("The comments in order, each followed by its replies"),
    })
    .describe("The post's comments"),
  example: { sort: "newest" },
  run: async ({ actor, projectId }, { number, sort }) => {
    const post = await findVisiblePost(actor, projectId, number);
    const ofTeam = (await actorReader(actor, projectId)) === null;
    // Liked by whoever calls (a key: its creator, as it votes).
    const caller = actingUserId(actor);
    const select = { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true } } } as const;
    const [comments, notes, team] = await Promise.all([
      // In the order they were written (the id breaks a tie: two in the same millisecond), as threads keeps it.
      prisma.comment.findMany({
        where: { postId: post.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { ...select, asReader: true, parentId: true, _count: { select: { likes: true } }, likes: { where: { userId: caller }, select: { userId: true } } },
      }),
      ofTeam ? prisma.postNote.findMany({ where: { postId: post.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select }) : [],
      prisma.teamMember.findMany({ where: { projectId }, select: { userId: true } }),
    ]);
    const teamIds = new Set(team.map((m) => m.userId));
    const all = [
      ...comments.map((c) => ({ ...c, internal: false, likes: c._count.likes, liked: c.likes.length > 0 })),
      // The team's notes between them, in order; never replied to or liked.
      ...notes.map((n) => ({ ...n, internal: true, asReader: false, parentId: null, likes: 0, liked: false })),
    ];
    return {
      comments: threads(all, sort)
        .flatMap((thread) => [thread.item, ...thread.replies])
        .map((c) => ({
          id: c.id,
          // A team member's comment written with a portal's session is a reader's (signedInAsReader).
          author: { name: c.author.name, team: teamIds.has(c.author.id) && !c.asReader },
          body: c.body,
          content: displayDoc(c),
          createdAt: c.createdAt.toISOString(),
          replyTo: c.parentId,
          likes: c.likes,
          liked: c.liked,
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
  const select = { ...postSummarySelect, id: true, body: true, eta: true, board: { select: { slug: true, name: true, off: true } }, author: { select: { name: true, image: true } } } as const;
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
  title: "Get the roadmap",
  summary:
    "Get the public roadmap: the planned, in progress and completed posts the caller may see, up to 50 a column. Planned and in progress are most voted first; completed, most recently finished first",
  method: "GET",
  path: "/roadmap",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  output: z
    .object({
      planned: z.array(postOutput).describe("Planned posts, up to 50"),
      inProgress: z.array(postOutput).describe("Posts in progress, up to 50"),
      completed: z.array(postOutput).describe("Completed posts, up to 50"),
    })
    .describe("The roadmap's columns"),
  run: async ({ actor, projectId }) => {
    const [columns, portal] = await Promise.all([roadmapColumns(projectId, await actorPostViewer(actor, projectId)), projectPortal(projectId)]);
    return Object.fromEntries(ROADMAP.map(({ key }, i) => [key, columns[i]!.map((post) => summary(post, portal))])) as Record<
      (typeof ROADMAP)[number]["key"],
      ReturnType<typeof summary>[]
    >;
  },
});
