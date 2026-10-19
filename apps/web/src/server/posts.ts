"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { canActIn } from "./membership";
import { createComment as createCommentOperation, createPost as createPostOperation } from "./operations/create";
import { asAnyone, call } from "./operations/run";
import { getSession } from "./session";

/** Posts on a portal board; see the posts.create operation. */
export async function createPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const value = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : undefined;
  };
  return asAnyone(
    "Sign in to post feedback",
    "Board not found",
    () => prisma.project.findUnique({ where: { slug: value("projectSlug") ?? "" }, select: { id: true } }),
    (context) =>
      call(createPostOperation, context, {
        board: value("boardSlug") ?? "",
        title: value("title") ?? "",
        content: value("content") || undefined,
        body: value("body"),
      }),
  );
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

/** Comments from portal users and from the team; see the comments.create operation. */
export async function addComment(_prev: FormState, formData: FormData): Promise<FormState> {
  const postId = String(formData.get("postId") ?? "");
  const value = (name: string) => {
    const field = formData.get(name);
    return typeof field === "string" ? field : undefined;
  };
  let number = 0;
  return asAnyone(
    "Sign in to comment",
    "Post not found",
    async () => {
      const post = await prisma.post.findUnique({ where: { id: postId }, select: { projectId: true, number: true } });
      number = post?.number ?? 0;
      return post && { id: post.projectId };
    },
    (context) =>
      call(createCommentOperation, context, { number, content: value("content") || undefined, body: value("body") }),
  );
}
