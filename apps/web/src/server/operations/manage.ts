import { type PostStatus, prisma } from "@tuti/db";
import { postStatusChanged } from "@tuti/jobs";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";
import { findPost, fromApiStatus, postNumber, postSummarySelect, projectPortal, STATUSES, summary } from "./read";

/** Team actions on posts: status, board and merging duplicates. */

export const updatePost = defineOperation({
  name: "posts.update",
  summary:
    "Change a post's status, move it to another board, or say who on the team looks after it (`owner`: a team member's email, null for nobody) and when it's expected (`eta`: a month like 2026-12, null for not said)",
  method: "PATCH",
  path: "/posts/{number}",
  scope: "write",
  access: "team",
  input: z
    .object({
      number: postNumber,
      status: z.enum(STATUSES).optional(),
      board: z.string().optional(),
      owner: z.email().nullable().optional(),
      eta: z
        .string()
        // A month this century, as 2026-12 (a year typed halfway, like 0002, isn't one).
        .regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "Say the month as 2026-12")
        .nullable()
        .optional(),
    })
    .refine((input) => [input.status, input.board, input.owner, input.eta].some((value) => value !== undefined), "Send a status, a board, an owner or an ETA")
    // The same rule, for the OpenAPI spec (a refine doesn't show up in JSON Schema).
    .meta({ anyOf: [{ required: ["status"] }, { required: ["board"] }, { required: ["owner"] }, { required: ["eta"] }] }),
  example: { status: "planned" },
  run: async ({ actor, projectId }, input) => {
    const post = await findPost(projectId, input.number);
    let boardId: string | undefined;
    if (input.board !== undefined) {
      const board = await prisma.board.findFirst({ where: { projectId, slug: input.board }, select: { id: true } });
      if (!board) {
        throw new OperationError(404, "not_found", "Board not found");
      }
      boardId = board.id;
    }
    // The ETA: a month's first day. The owner: found on the team in the update's transaction (below).
    const eta = input.eta === undefined ? undefined : input.eta === null ? null : new Date(`${input.eta}-01T00:00:00Z`);
    // Before the change is written (see posts.create).
    const portal = await projectPortal(projectId);
    const status = input.status && fromApiStatus(input.status);
    // The change and its event (the post's activity) together: by whoever made it (an API key: its creator).
    // The status it has now, read with its row locked: changes at the same moment (a teammate, publishing its entry) go one after the other.
    const { updated, previous } = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: PostStatus }[]>`SELECT status FROM post WHERE id = ${post.id} FOR UPDATE`;
      const previous = current?.status ?? post.status;
      // The owner is on the team (by their email), its membership row held until this commits: taken off the
      // team meanwhile, their removal waits for this, and then clears them as owner.
      let ownerId: string | null | undefined;
      if (input.owner !== undefined) {
        ownerId = null;
        if (input.owner !== null) {
          const [member] = await tx.$queryRaw<{ userId: string }[]>`
            SELECT m."userId" FROM team_member m JOIN "user" u ON u.id = m."userId"
            WHERE m."projectId" = ${projectId} AND lower(u.email) = lower(${input.owner}) FOR SHARE OF m`;
          if (!member) {
            throw new OperationError(400, "invalid_input", "The owner must be on your team");
          }
          ownerId = member.userId;
        }
      }
      const saved = await tx.post.update({
        where: { id: post.id },
        data: { ...(status && { status }), ...(boardId && { boardId }), ...(ownerId !== undefined && { ownerId }), ...(eta !== undefined && { eta }) },
        select: postSummarySelect,
      });
      if (status && status !== previous) {
        await tx.postEvent.create({ data: { postId: post.id, actorId: actor.kind === "user" ? actor.userId : actor.createdById, from: previous, to: status } });
      }
      return { updated: saved, previous };
    });
    const result = summary(updated, portal);
    if (updated.status !== previous) {
      await postStatusChanged(projectId, post.id, result, previous);
    }
    return result;
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
  example: { into: 12 },
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
    prisma.postNote.updateMany({ where: { postId: from }, data: { postId: to } }),
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
