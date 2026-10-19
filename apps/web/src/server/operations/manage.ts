import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";
import { findPost, fromApiStatus, postNumber, postSummarySelect, projectSlug, STATUSES, summary } from "./read";

/** Team actions on posts: status, board and merging duplicates. */

export const updatePost = defineOperation({
  name: "posts.update",
  summary: "Change a post's status or move it to another board",
  method: "PATCH",
  path: "/posts/{number}",
  scope: "write",
  access: "team",
  input: z
    .object({ number: postNumber, status: z.enum(STATUSES).optional(), board: z.string().optional() })
    .refine((input) => input.status !== undefined || input.board !== undefined, "Send a status or a board"),
  run: async ({ projectId }, input) => {
    const post = await findPost(projectId, input.number);
    let boardId: string | undefined;
    if (input.board !== undefined) {
      const board = await prisma.board.findFirst({ where: { projectId, slug: input.board }, select: { id: true } });
      if (!board) {
        throw new OperationError(404, "not_found", "Board not found");
      }
      boardId = board.id;
    }
    const updated = await prisma.post.update({
      where: { id: post.id },
      data: { ...(input.status && { status: fromApiStatus(input.status) }), ...(boardId && { boardId }) },
      select: postSummarySelect,
    });
    return summary(updated, await projectSlug(projectId));
  },
});

export const mergePost = defineOperation({
  name: "posts.merge",
  summary: "Merge a duplicate into another post: votes and comments move over, and the duplicate leaves every list",
  method: "POST",
  path: "/posts/{number}/merge",
  scope: "write",
  access: "team",
  input: z.object({ number: postNumber, into: z.number().int().positive() }),
  run: async ({ projectId }, input) => {
    const [post, target] = await Promise.all([findPost(projectId, input.number), findPost(projectId, input.into)]);
    const into = await mergePosts(post.id, target.id);
    return { merged: post.number, into };
  },
});

/**
 * Merges a duplicate into another post. Votes move over (people who voted on
 * both count once), comments move over, earlier duplicates are re-pointed, and
 * the duplicate leaves all lists (its URL redirects to the original). No undo.
 * Returns the number of the post it ended up in.
 */
export async function mergePosts(fromId: string, toId: string): Promise<number> {
  const post = await prisma.post.findUniqueOrThrow({ where: { id: fromId }, select: { id: true, duplicateOfId: true } });
  if (post.duplicateOfId) {
    throw new OperationError(409, "already_merged", "This post was already merged");
  }
  // Merging into a post that was itself merged goes to its final original.
  let target = await prisma.post.findUniqueOrThrow({
    where: { id: toId },
    select: { id: true, number: true, duplicateOfId: true },
  });
  for (let hops = 0; target.duplicateOfId && hops < 10; hops++) {
    target = await prisma.post.findUniqueOrThrow({
      where: { id: target.duplicateOfId },
      select: { id: true, number: true, duplicateOfId: true },
    });
  }
  if (target.id === post.id) {
    throw new OperationError(409, "merge_into_itself", "Can't merge a post into itself");
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
    // The merged post is out of every list, so its duplicate suggestions are settled.
    prisma.duplicateSuggestion.deleteMany({ where: { OR: [{ postId: from }, { originalId: from }] } }),
    prisma.$executeRaw`
      UPDATE post SET
        "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = ${to}),
        "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = ${to})
      WHERE id = ${to}`,
  ]);
  return target.number;
}
