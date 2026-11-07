import { prisma } from "@tuti/db";
import { syncUsers as syncProjectUsers, TooManyProperties, upsertProjectUser, type UserDetails } from "@tuti/jobs";

import { type Actor, OperationError } from "./operations/define";

export { upsertProjectUser, type UserDetails } from "@tuti/jobs";

/**
 * Someone from the project's app an API call names (`author`, `user`): created on first sight with what's given; after
 * that their name and email change only when the caller (a key's creator) is an owner or admin, as users.sync needs.
 */
export async function namedProjectUser(actor: Actor, projectId: string, user: { id: string; name?: string; email?: string }) {
  const caller = actor.kind === "user" ? actor.userId : actor.createdById;
  const [admin, existing] = await Promise.all([
    prisma.teamMember.findFirst({ where: { projectId, userId: caller, role: { in: ["OWNER", "ADMIN"] } }, select: { id: true } }),
    prisma.ssoIdentity.findUnique({ where: { projectId_externalId: { projectId, externalId: user.id } }, select: { userId: true } }),
  ]);
  if (existing && !admin) {
    return existing.userId;
  }
  // ponytail: someone created by another call between the lookup and here gets these details, as on first sight.
  return upsertProjectUser(projectId, user.id, { name: user.name, email: user.email });
}

/** syncUsers (in @tuti/jobs, so imports in the worker use it too), with `strict`'s refusal as the API's 400. */
export async function syncUsers(projectId: string, users: UserDetails[], options: { strict?: boolean } = {}) {
  try {
    return await syncProjectUsers(projectId, users, options);
  } catch (error) {
    if (error instanceof TooManyProperties) {
      throw new OperationError(400, "invalid_input", error.message);
    }
    throw error;
  }
}
