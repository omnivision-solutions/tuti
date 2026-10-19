import { prisma, type PostStatus } from "@tuti/db";
import { z } from "zod";

import { portalUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";

import { displayDoc } from "../content";
import { defineOperation, OperationError } from "./define";
import { linkSelect, linkView } from "./link-view";

/** Statuses as the API spells them. */
export const STATUSES = ["open", "under_review", "planned", "in_progress", "completed", "closed"] as const;
export const toApiStatus = (status: PostStatus) => status.toLowerCase() as (typeof STATUSES)[number];
export const fromApiStatus = (status: (typeof STATUSES)[number]) => status.toUpperCase() as PostStatus;

export async function projectSlug(projectId: string) {
  return (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } })).slug;
}

export const listBoards = defineOperation({
  name: "boards.list",
  summary: "List the project's boards",
  method: "GET",
  path: "/boards",
  scope: "read",
  access: "anyone",
  input: z.object({}),
  run: async ({ projectId }) => {
    const boards = await prisma.board.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { slug: true, name: true, _count: { select: { posts: { where: { duplicateOfId: null } } } } },
    });
    return { boards: boards.map((b) => ({ slug: b.slug, name: b.name, posts: b._count.posts })) };
  },
});

export const postSummarySelect = {
  number: true,
  title: true,
  status: true,
  voteCount: true,
  commentCount: true,
  createdAt: true,
  board: { select: { slug: true } },
  author: { select: { name: true } },
} as const;

type PostRow = {
  number: number;
  title: string;
  status: PostStatus;
  voteCount: number;
  commentCount: number;
  createdAt: Date;
  board: { slug: string };
  author: { name: string };
};

export const summary = (post: PostRow, slug: string) => ({
  number: post.number,
  title: post.title,
  status: toApiStatus(post.status),
  board: post.board.slug,
  votes: post.voteCount,
  comments: post.commentCount,
  author: { name: post.author.name },
  createdAt: post.createdAt.toISOString(),
  url: `${portalUrl(slug)}${postPath(post)}`,
});

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
  run: async ({ projectId }, input) => {
    // ponytail: offset cursors; switch to keyset pagination if projects get very large.
    const posts = await prisma.post.findMany({
      where: {
        projectId,
        duplicateOfId: null,
        ...(input.board && { board: { slug: input.board } }),
        ...(input.status && { status: fromApiStatus(input.status) }),
      },
      orderBy: input.sort === "new" ? [{ createdAt: "desc" }] : [{ voteCount: "desc" }, { createdAt: "desc" }],
      skip: input.cursor,
      take: input.limit + 1,
      select: postSummarySelect,
    });
    const slug = await projectSlug(projectId);
    const more = posts.length > input.limit;
    return {
      posts: posts.slice(0, input.limit).map((post) => summary(post, slug)),
      nextCursor: more ? String(input.cursor + input.limit) : null,
    };
  },
});

export const postNumber = z.coerce.number().int().positive();

export async function findPost(projectId: string, number: number) {
  const post = await prisma.post.findUnique({
    where: { projectId_number: { projectId, number } },
    select: { ...postSummarySelect, id: true, body: true, content: true, duplicateOf: { select: { number: true } } },
  });
  if (!post) {
    throw new OperationError(404, "not_found", `There's no post #${number}`);
  }
  return post;
}

export const getPost = defineOperation({
  name: "posts.get",
  summary: "Get a post by its number, with its text and rich content",
  method: "GET",
  path: "/posts/{number}",
  scope: "read",
  access: "anyone",
  input: z.object({ number: postNumber }),
  run: async ({ projectId }, { number }) => {
    const post = await findPost(projectId, number);
    const links = await prisma.postLink.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" }, select: linkSelect });
    return {
      ...summary(post, await projectSlug(projectId)),
      body: post.body,
      content: displayDoc(post),
      mergedInto: post.duplicateOf?.number ?? null,
      links: links.map(linkView),
    };
  },
});

export const listComments = defineOperation({
  name: "comments.list",
  summary: "List a post's comments, oldest first",
  method: "GET",
  path: "/posts/{number}/comments",
  scope: "read",
  access: "anyone",
  input: z.object({ number: postNumber }),
  run: async ({ projectId }, { number }) => {
    const post = await findPost(projectId, number);
    const [comments, team] = await Promise.all([
      prisma.comment.findMany({
        where: { postId: post.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true } } },
      }),
      prisma.teamMember.findMany({ where: { projectId }, select: { userId: true } }),
    ]);
    const teamIds = new Set(team.map((m) => m.userId));
    return {
      comments: comments.map((c) => ({
        id: c.id,
        author: { name: c.author.name, team: teamIds.has(c.author.id) },
        body: c.body,
        content: displayDoc(c),
        createdAt: c.createdAt.toISOString(),
      })),
    };
  },
});
