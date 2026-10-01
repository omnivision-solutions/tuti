"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";
import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { getMembership } from "./membership";

/**
 * Actions the project's team takes on posts (any team role). Portal users act
 * through server/posts.ts instead.
 */

/**
 * Moves a post to another board in the same project. Votes and comments belong
 * to the post, and its number (and so its URL) is per project, so nothing else
 * changes.
 */
export async function movePost(projectSlug: string, postId: string, boardSlug: string): Promise<FormState> {
  const membership = await getMembership(projectSlug);
  if (!membership) {
    return { error: "Only the project's team can move posts" };
  }
  const projectId = membership.project.id;

  const [post, board] = await Promise.all([
    prisma.post.findFirst({ where: { id: postId, projectId }, select: { id: true } }),
    prisma.board.findFirst({ where: { slug: boardSlug, projectId }, select: { id: true } }),
  ]);
  if (!post) {
    return { error: "Post not found" };
  }
  if (!board) {
    return { error: "Board not found" };
  }

  await prisma.post.update({ where: { id: post.id }, data: { boardId: board.id } });
  refresh();
  return {};
}

const statusSchema = z.enum(["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"]);

export async function changePostStatus(projectSlug: string, postId: string, status: string): Promise<FormState> {
  const membership = await getMembership(projectSlug);
  if (!membership) {
    return { error: "Only the project's team can change a post's status" };
  }
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) {
    return { error: "Unknown status" };
  }
  const { count } = await prisma.post.updateMany({
    where: { id: postId, projectId: membership.project.id },
    data: { status: parsed.data },
  });
  if (count === 0) {
    return { error: "Post not found" };
  }
  refresh();
  return {};
}
