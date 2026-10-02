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

/**
 * Merges a duplicate into another post. Votes move over (people who voted on
 * both count once), comments move over, earlier duplicates are re-pointed, and
 * the duplicate leaves all lists (its URL redirects to the original). No undo.
 */
export async function mergePost(projectSlug: string, postId: string, targetPostId: string): Promise<FormState> {
  const membership = await getMembership(projectSlug);
  if (!membership) {
    return { error: "Only the project's team can merge posts" };
  }
  const projectId = membership.project.id;

  const post = await prisma.post.findFirst({ where: { id: postId, projectId }, select: { id: true, duplicateOfId: true } });
  let target = await prisma.post.findFirst({
    where: { id: targetPostId, projectId },
    select: { id: true, duplicateOfId: true },
  });
  if (!post || !target) {
    return { error: "Post not found" };
  }
  if (post.duplicateOfId) {
    return { error: "This post was already merged" };
  }
  // Merging into a post that was itself merged goes to its final original.
  for (let hops = 0; target.duplicateOfId && hops < 10; hops++) {
    target = await prisma.post.findUniqueOrThrow({
      where: { id: target.duplicateOfId },
      select: { id: true, duplicateOfId: true },
    });
  }
  if (target.id === post.id) {
    return { error: "Can't merge a post into itself" };
  }

  const from = post.id;
  const to = target.id;
  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO vote ("postId", "userId", "projectId", "createdAt")
      SELECT ${to}, "userId", "projectId", "createdAt" FROM vote WHERE "postId" = ${from}
      ON CONFLICT ("postId", "userId") DO NOTHING`,
    prisma.vote.deleteMany({ where: { postId: from } }),
    prisma.comment.updateMany({ where: { postId: from }, data: { postId: to } }),
    prisma.post.updateMany({ where: { duplicateOfId: from }, data: { duplicateOfId: to } }),
    prisma.post.update({ where: { id: from }, data: { duplicateOfId: to, voteCount: 0, commentCount: 0 } }),
    prisma.$executeRaw`
      UPDATE post SET
        "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = ${to}),
        "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = ${to})
      WHERE id = ${to}`,
  ]);
  refresh();
  return {};
}
