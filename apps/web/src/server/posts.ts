"use server";

import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/shared/hatchet";
import { refresh } from "next/cache";
import { z } from "zod";

import type { FormState } from "./form-state";
import { getSession } from "./session";

/**
 * Users who came in through a project's SSO belong to that project: their
 * identity is vouched for by its app only, so they can't act in other projects.
 */
async function canActIn(userId: string, projectId: string): Promise<boolean> {
  const identity = await prisma.ssoIdentity.findUnique({ where: { userId }, select: { projectId: true } });
  return !identity || identity.projectId === projectId;
}

const createPostSchema = z.object({
  projectSlug: z.string(),
  boardSlug: z.string(),
  title: z.string().trim().min(3, "Title is too short").max(120),
  body: z.string().trim().max(5000),
});

export async function createPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to post feedback" };
  }

  const parsed = createPostSchema.safeParse({
    projectSlug: formData.get("projectSlug"),
    boardSlug: formData.get("boardSlug"),
    title: formData.get("title"),
    body: formData.get("body") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const board = await prisma.board.findFirst({
    where: { slug: parsed.data.boardSlug, project: { slug: parsed.data.projectSlug } },
    select: { id: true, projectId: true },
  });
  if (!board || !(await canActIn(session.user.id, board.projectId))) {
    return { error: "Board not found" };
  }

  const post = await prisma.$transaction(async (tx) => {
    // Locks the project row, so concurrent posts get distinct numbers.
    const { postCount: number } = await tx.project.update({
      where: { id: board.projectId },
      data: { postCount: { increment: 1 } },
      select: { postCount: true },
    });
    // Authors automatically upvote their own post.
    return tx.post.create({
      data: {
        projectId: board.projectId,
        boardId: board.id,
        authorId: session.user.id,
        number,
        title: parsed.data.title,
        body: parsed.data.body,
        voteCount: 1,
        votes: { create: { userId: session.user.id, projectId: board.projectId } },
      },
      select: { id: true },
    });
  });

  // Background work must never block or fail the user's request.
  try {
    await enqueue("postCreated", { projectId: board.projectId, postId: post.id });
  } catch (error) {
    console.error("Failed to enqueue post-created job", error);
  }

  refresh();
  return {};
}

export async function toggleVote(postId: string): Promise<FormState> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to vote" };
  }
  const userId = session.user.id;

  const target = await prisma.post.findUnique({ where: { id: postId }, select: { projectId: true, duplicateOfId: true } });
  if (!target || !(await canActIn(userId, target.projectId))) {
    return { error: "Post not found" };
  }
  if (target.duplicateOfId) {
    return { error: "This post was merged into another one; vote there instead" };
  }

  await prisma.$transaction(async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { projectId: true } });
    if (!post) {
      return;
    }

    const removed = await tx.vote.deleteMany({ where: { postId, userId } });
    if (removed.count > 0) {
      await tx.post.update({ where: { id: postId }, data: { voteCount: { decrement: 1 } } });
      return;
    }

    await tx.vote.create({ data: { postId, userId, projectId: post.projectId } });
    await tx.post.update({ where: { id: postId }, data: { voteCount: { increment: 1 } } });
  });

  refresh();
  return {};
}

const addCommentSchema = z.object({
  postId: z.string().min(1),
  body: z.string().trim().min(1, "Write something first").max(5000),
});

/** Comments from portal users and from the team (the team badge is shown when rendering). */
export async function addComment(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to comment" };
  }
  const parsed = addCommentSchema.safeParse({ postId: formData.get("postId"), body: formData.get("body") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const post = await prisma.post.findUnique({
    where: { id: parsed.data.postId },
    select: { id: true, projectId: true, duplicateOfId: true },
  });
  if (!post || !(await canActIn(session.user.id, post.projectId))) {
    return { error: "Post not found" };
  }
  if (post.duplicateOfId) {
    return { error: "This post was merged into another one; comment there instead" };
  }

  await prisma.$transaction([
    prisma.comment.create({
      data: { projectId: post.projectId, postId: post.id, authorId: session.user.id, body: parsed.data.body },
    }),
    prisma.post.update({ where: { id: post.id }, data: { commentCount: { increment: 1 } } }),
  ]);
  refresh();
  return {};
}
