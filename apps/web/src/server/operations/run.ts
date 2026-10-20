import { prisma } from "@tuti/db";
import { refresh } from "next/cache";
import type { z } from "zod";

import { canActIn, getAdminProject, getMembership } from "../membership";
import { getSession } from "../session";
import { type Actor, type Operation, OperationError } from "./define";

type Context = { actor: Actor; projectId: string };

/** Runs an operation with its input checked first, as every surface does. */
export async function call<I extends z.ZodType, O>(
  operation: Operation<I, O>,
  context: Context,
  input: z.input<I>,
): Promise<O> {
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    throw new OperationError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  return operation.run(context, parsed.data);
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
  return asUser(session && membership && { userId: session.user.id, projectId: membership.project.id }, denied, fn);
}

/** Like asTeam, for project settings (operations with `access: "admin"`): owners and admins only, like the Settings page. */
export async function asAdmin(
  projectSlug: string,
  denied: string,
  fn: (context: Context) => Promise<unknown>,
): Promise<{ error?: string }> {
  const [session, project] = await Promise.all([getSession(), getAdminProject(projectSlug)]);
  return asUser(session && project && { userId: session.user.id, projectId: project.id }, denied, fn);
}

async function asUser(
  allowed: { userId: string; projectId: string } | null,
  denied: string,
  fn: (context: Context) => Promise<unknown>,
): Promise<{ error?: string }> {
  if (!allowed) {
    return { error: denied };
  }
  try {
    await fn({ actor: { kind: "user", userId: allowed.userId }, projectId: allowed.projectId });
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  refresh();
  return {};
}

/**
 * For the app's server actions anyone may take in a project (posting, commenting):
 * the signed-in user must be allowed to act there (users from another project's
 * SSO aren't). `project` finds the project from the action's arguments.
 */
export async function asAnyone(
  signedOut: string,
  notFound: string,
  project: () => Promise<{ id: string } | null>,
  fn: (context: Context) => Promise<unknown>,
): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) {
    return { error: signedOut };
  }
  const found = await project();
  if (!found || !(await canActIn(session.user.id, found.id))) {
    return { error: notFound };
  }
  try {
    await fn({ actor: { kind: "user", userId: session.user.id }, projectId: found.id });
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
