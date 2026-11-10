"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { createComment as createCommentOperation, createPost as createPostOperation } from "./operations/create";
import { likeComment, setSubscription, setVote } from "./operations/more";
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

/** Follows a post, or stops, for the signed-in user; see the subscriptions.set operation. */
export async function setPostSubscription(postId: string, subscribed: boolean): Promise<FormState> {
  let number = 0;
  return asAnyone(
    "Sign in to subscribe",
    "Post not found",
    async () => {
      const post = await prisma.post.findUnique({ where: { id: String(postId) }, select: { projectId: true, number: true } });
      number = post?.number ?? 0;
      return post && { id: post.projectId };
    },
    (context) => call(setSubscription, context, { number, subscribed: subscribed === true }),
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
        replyTo: value("replyTo") || undefined,
      }),
  );
}

/** Likes a comment, or takes the like back, for the signed-in user; see the comments.like operation. */
export async function setCommentLike(commentId: string, liked: boolean): Promise<FormState> {
  let found: { number: number; id: string } | null = null;
  return asAnyone(
    "Sign in to like comments",
    "Comment not found",
    async () => {
      const comment = await prisma.comment.findUnique({ where: { id: String(commentId) }, select: { projectId: true, post: { select: { number: true } } } });
      found = comment && { number: comment.post.number, id: String(commentId) };
      return comment && { id: comment.projectId };
    },
    (context) => call(likeComment, context, { number: found!.number, id: found!.id, liked: liked === true }),
  );
}
