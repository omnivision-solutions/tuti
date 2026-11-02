import { type PostStatus, prisma } from "@tuti/db";
import { postStatusChanged } from "@tuti/jobs";
import { z } from "zod";

import { lockSampleContent } from "../sample-content";
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
      // The owner is on the team (by their email), its membership row held until this commits: taken off the
      // team meanwhile, their removal waits for this, and then clears them as owner. Held before the post's row,
      // in the order their removal takes them, so the two never wait on each other.
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
      const [current] = await tx.$queryRaw<{ status: PostStatus }[]>`SELECT status FROM post WHERE id = ${post.id} FOR UPDATE`;
      const previous = current?.status ?? post.status;
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
 * Merges a duplicate into another post. Votes and subscriptions move over (people who voted on
 * both count once), comments move over, earlier duplicates are re-pointed, and
 * the duplicate leaves all lists (its URL redirects to the original). No undo.
 * Returns the number of the post it ended up in.
 */
export async function mergePosts(fromId: string, toId: string): Promise<number> {
  const post = await prisma.post.findUniqueOrThrow({ where: { id: fromId }, select: { id: true, projectId: true, duplicateOfId: true, sample: true } });
  if (post.duplicateOfId) {
    throw new OperationError(409, "already_merged", "This post was already merged");
  }
  // Merging into a post that was itself merged goes to its final original.
  let target = await prisma.post.findUniqueOrThrow({
    where: { id: toId },
    select: { id: true, number: true, duplicateOfId: true, sample: true },
  });
  for (let hops = 0; target.duplicateOfId && hops < 10; hops++) {
    target = await prisma.post.findUniqueOrThrow({
      where: { id: target.duplicateOfId },
      select: { id: true, number: true, duplicateOfId: true, sample: true },
    });
  }
  if (target.id === post.id) {
    throw new OperationError(409, "merge_into_itself", "Can't merge a post into itself");
  }
  // Sample content (server/sample-content.ts) never mixes with the team's: a sample post would take a real post's votes
  // with it when it's removed, and a real post would count (and email) the sample people.
  if (target.sample && !post.sample) {
    throw new OperationError(409, "merge_into_sample", "Sample posts are removed with the sample content: merge into one of your own");
  }
  if (post.sample && !target.sample) {
    throw new OperationError(409, "merge_sample", "Sample posts can only be merged into other sample posts");
  }

  const from = post.id;
  const to = target.id;
  await prisma.$transaction(async (tx) => {
    // Merging a sample post: the project's lock before the posts', in the order removing sample content takes them, so
    // the two can't deadlock.
    if (post.sample) {
      await lockSampleContent(tx, post.projectId);
    }
    // Both posts locked first, in a fixed order, and checked again under the lock: a merge of either, or a link
    // to either (conversations.linkPost), waits for this one, and nothing merged meanwhile is merged twice or into.
    const locked = await tx.$queryRaw<{ id: string; duplicateOfId: string | null }[]>`
      SELECT id, "duplicateOfId" FROM post WHERE id IN (${from}, ${to}) ORDER BY id FOR NO KEY UPDATE`;
    if (locked.find((row) => row.id === from)?.duplicateOfId) {
      throw new OperationError(409, "already_merged", "This post was already merged");
    }
    if (locked.find((row) => row.id === to)?.duplicateOfId) {
      throw new OperationError(409, "target_merged", "The post to merge into was just merged into another: try again");
    }
    await tx.$executeRaw`
      INSERT INTO vote ("postId", "userId", "projectId", "createdAt")
      SELECT ${to}, "userId", "projectId", "createdAt" FROM vote WHERE "postId" = ${from}
      ON CONFLICT ("postId", "userId") DO NOTHING`;
    await tx.vote.deleteMany({ where: { postId: from } });
    await tx.$executeRaw`
      INSERT INTO post_subscription ("postId", "userId", "createdAt")
      SELECT ${to}, "userId", "createdAt" FROM post_subscription WHERE "postId" = ${from}
      ON CONFLICT ("postId", "userId") DO NOTHING`;
    await tx.postSubscription.deleteMany({ where: { postId: from } });
    // A reply still to be emailed to its post's voters (Email voters) isn't, once moved: the target's voters never saw it asked.
    await tx.comment.updateMany({ where: { postId: from }, data: { postId: to, votersEmailDueAt: null } });
    await tx.postNote.updateMany({ where: { postId: from }, data: { postId: to } });
    // Conversations about it are about the post it's merged into.
    await tx.$executeRaw`
      INSERT INTO conversation_post ("conversationId", "postId", "createdAt")
      SELECT "conversationId", ${to}, "createdAt" FROM conversation_post WHERE "postId" = ${from}
      ON CONFLICT ("conversationId", "postId") DO NOTHING`;
    await tx.conversationPost.deleteMany({ where: { postId: from } });
    await tx.post.updateMany({ where: { duplicateOfId: from }, data: { duplicateOfId: to } });
    await tx.post.update({ where: { id: from }, data: { duplicateOfId: to, voteCount: 0, commentCount: 0 } });
    // The merged post is out of every list, so its duplicate suggestions are settled.
    await tx.duplicateSuggestion.deleteMany({ where: { OR: [{ postId: from }, { originalId: from }] } });
    await tx.$executeRaw`
      UPDATE post SET
        "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = ${to}),
        "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = ${to})
      WHERE id = ${to}`;
    // Past Prisma's 5 seconds: a merge may wait for a vote on either post, and move thousands of votes.
  }, { timeout: 30_000 });
  return target.number;
}
