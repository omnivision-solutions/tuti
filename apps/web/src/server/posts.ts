"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { createComment as createCommentOperation, createPost as createPostOperation } from "./operations/create";
import { setVote } from "./operations/more";
import { asAnyone, call } from "./operations/run";

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

/** Votes, or takes the vote back, for the signed-in user; see the votes.set operation. */
export async function toggleVote(postId: string): Promise<FormState> {
  let number = 0;
  return asAnyone(
    "Sign in to vote",
    "Post not found",
    async () => {
      const post = await prisma.post.findUnique({ where: { id: String(postId) }, select: { projectId: true, number: true } });
      number = post?.number ?? 0;
      return post && { id: post.projectId };
    },
    async (context) => {
      const userId = context.actor.kind === "user" ? context.actor.userId : "";
      const voted = await prisma.vote.findFirst({ where: { post: { number, projectId: context.projectId }, userId } });
      return call(setVote, context, { number, voted: !voted });
    },
  );
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
      // An internal note, or a reply emailed to the voters, when the team's form asks (the operation refuses anyone else).
      call(createCommentOperation, context, {
        number,
        content: value("content") || undefined,
        body: value("body"),
        ...(value("internal") === "on" && { internal: true }),
        ...(value("emailVoters") === "on" && { emailVoters: true }),
      }),
  );
}
