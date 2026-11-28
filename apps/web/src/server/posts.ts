"use server";

import { prisma } from "@tuti/db";

import type { FormState } from "./form-state";
import { createPost as createPostOperation } from "./operations/create";
import { setSubscription } from "./operations/more";
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
