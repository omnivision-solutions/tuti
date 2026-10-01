"use server";

import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/shared/hatchet";
import { refresh } from "next/cache";
import { z } from "zod";

import type { FormState } from "./form-state";
import { getSession } from "./session";

const createPostSchema = z.object({
  workspaceSlug: z.string(),
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
    workspaceSlug: formData.get("workspaceSlug"),
    boardSlug: formData.get("boardSlug"),
    title: formData.get("title"),
    body: formData.get("body") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const board = await prisma.board.findFirst({
    where: { slug: parsed.data.boardSlug, workspace: { slug: parsed.data.workspaceSlug } },
    select: { id: true, workspaceId: true },
  });
  if (!board) {
    return { error: "Board not found" };
  }

  // Authors automatically upvote their own post.
  const post = await prisma.post.create({
    data: {
      workspaceId: board.workspaceId,
      boardId: board.id,
      authorId: session.user.id,
      title: parsed.data.title,
      body: parsed.data.body,
      voteCount: 1,
      votes: { create: { userId: session.user.id, workspaceId: board.workspaceId } },
    },
    select: { id: true },
  });

  // Background work must never block or fail the user's request.
  try {
    await enqueue("postCreated", { workspaceId: board.workspaceId, postId: post.id });
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

  await prisma.$transaction(async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { workspaceId: true } });
    if (!post) {
      return;
    }

    const removed = await tx.vote.deleteMany({ where: { postId, userId } });
    if (removed.count > 0) {
      await tx.post.update({ where: { id: postId }, data: { voteCount: { decrement: 1 } } });
      return;
    }

    await tx.vote.create({ data: { postId, userId, workspaceId: post.workspaceId } });
    await tx.post.update({ where: { id: postId }, data: { voteCount: { increment: 1 } } });
  });

  refresh();
  return {};
}
