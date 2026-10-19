"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";
import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { getMembership } from "./membership";
import { OperationError } from "./operations";
import { addLink, removeLink } from "./operations/links";
import { mergePost as mergeOperation, updatePost } from "./operations/manage";
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

/** "Not a duplicate": hides a suggestion for good (the worker won't suggest the pair again). */
export async function dismissDuplicate(projectSlug: string, suggestionId: string): Promise<FormState> {
  const membership = await getMembership(projectSlug);
  if (!membership) {
    return { error: "Only the project's team can dismiss duplicates" };
  }
  const { count } = await prisma.duplicateSuggestion.updateMany({
    where: { id: suggestionId, projectId: membership.project.id },
    data: { status: "DISMISSED" },
  });
  if (count === 0) {
    return { error: "Suggestion not found" };
  }
  refresh();
  return {};
}

/** Links a post to a GitHub pull request, issue or release (see the links.add operation). */
export async function addPostLink(projectSlug: string, postId: string, url: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can link posts", async (context) =>
    call(addLink, context, { number: await postNumberOf(context.projectId, postId), url: String(url) }),
  );
}

export async function removePostLink(projectSlug: string, postId: string, linkId: string): Promise<FormState> {
  return asTeam(projectSlug, "Only the project's team can link posts", async (context) =>
    call(removeLink, context, { number: await postNumberOf(context.projectId, postId), id: String(linkId) }),
  );
}
