"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

import type { FormState } from "./form-state";
import { OperationError } from "./operations";
import { removeLink } from "./operations/links";
import { mergePost as mergeOperation, updatePost } from "./operations/manage";
import { dismissDuplicate as dismissOperation } from "./operations/more";
import { toApiStatus } from "./operations/read";
import { asTeam, call, postNumberOf } from "./operations/run";

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
  return asTeam(projectSlug, "Only the project's team can move posts", async (context) =>
    call(updatePost, context, { number: await postNumberOf(context.projectId, postId), board: String(boardSlug) }),
  );
}

/** Who on the team looks after a post (a team member's id; null: nobody). See posts.update. */
export async function setPostOwner(projectSlug: string, postId: string, ownerId: string | null): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can change a post's owner", async (context) => {
    const owner = ownerId === null ? null : await prisma.user.findUnique({ where: { id: String(ownerId) }, select: { email: true } });
    if (ownerId !== null && !owner) {
      throw new OperationError(400, "invalid_input", "The owner must be on your team");
    }
    return call(updatePost, context, { number: await postNumberOf(context.projectId, postId), owner: owner?.email ?? null });
  });
}

/** When the team expects a post: a month ("2026-12"; null: not said). See posts.update. */
export async function setPostEta(projectSlug: string, postId: string, month: string | null): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can change a post's ETA", async (context) =>
    call(updatePost, context, { number: await postNumberOf(context.projectId, postId), eta: month === null || month === "" ? null : String(month) }),
  );
}

const statusSchema = z.enum(["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"]);

export async function changePostStatus(projectSlug: string, postId: string, status: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can change a post's status", async (context) => {
    const parsed = statusSchema.safeParse(status);
    if (!parsed.success) {
      throw new OperationError(400, "invalid_input", "Unknown status");
    }
    const number = await postNumberOf(context.projectId, postId);
    return call(updatePost, context, { number, status: toApiStatus(parsed.data) });
  });
}

/** Merges a duplicate into another post (see the posts.merge operation). No undo. */
export async function mergePost(projectSlug: string, postId: string, targetPostId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can merge posts", async (context) => {
    const [number, into] = await Promise.all([
      postNumberOf(context.projectId, postId),
      postNumberOf(context.projectId, targetPostId),
    ]);
    return call(mergeOperation, context, { number, into });
  });
}

/** "Not a duplicate": hides a suggestion for good (see the duplicates.dismiss operation). */
export async function dismissDuplicate(projectSlug: string, suggestionId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can dismiss duplicates", (context) =>
    call(dismissOperation, context, { id: String(suggestionId) }),
  );
}

export async function removePostLink(projectSlug: string, postId: string, linkId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can link posts", async (context) =>
    call(removeLink, context, { number: await postNumberOf(context.projectId, postId), id: String(linkId) }),
  );
}
