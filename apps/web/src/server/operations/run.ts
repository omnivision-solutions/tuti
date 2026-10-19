import { prisma } from "@tuti/db";
import { refresh } from "next/cache";
import type { z } from "zod";

import { getMembership } from "../membership";
import { getSession } from "../session";
import { type Actor, type Operation, OperationError } from "./define";

type Context = { actor: Actor; projectId: string };

/** Runs an operation with its input checked first, as every surface does. */
export function call<I extends z.ZodType, O>(operation: Operation<I, O>, context: Context, input: z.input<I>): Promise<O> {
  return operation.run(context, operation.input.parse(input));
}

/**
 * For the app's server actions on team operations: the signed-in user must be on
 * the project's team. Expected failures come back as `{ error }`, like every action.
 */
export async function asTeam(
  projectSlug: string,
  denied: string,
  fn: (context: Context) => Promise<unknown>,
): Promise<{ error?: string }> {
  const [session, membership] = await Promise.all([getSession(), getMembership(projectSlug)]);
  if (!session || !membership) {
    return { error: denied };
  }
  try {
    await fn({ actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id });
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  refresh();
  return {};
}

/** The project's number for a post id, which is what operations take. */
export async function postNumberOf(projectId: string, postId: string): Promise<number> {
  const post = await prisma.post.findFirst({ where: { id: String(postId), projectId }, select: { number: true } });
  if (!post) {
    throw new OperationError(404, "not_found", "Post not found");
  }
  return post.number;
}
