"use server";

import { Prisma, type TeamRole, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { canAssignRole, canManageTeamMember } from "@/lib/roles";

import { getMembership, teamRoleIn } from "./membership";
import { getSession } from "./session";

type Result = { error?: string };

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

/** The acting team member and the one being changed, both in this project. */
async function loadPair(projectSlug: string, memberId: string) {
  const actor = await getMembership(projectSlug);
  if (!actor) {
    return null;
  }
  const target = await prisma.teamMember.findFirst({
    where: { id: memberId, projectId: actor.project.id },
    select: { id: true, role: true, userId: true },
  });
  return target ? { actor, target } : null;
}

/** A project must always keep at least one owner. Counted under the project's lock. */
async function isLastOwner(tx: Prisma.TransactionClient, projectId: string, role: TeamRole): Promise<boolean> {
  if (role !== "OWNER") {
    return false;
  }
  return (await tx.teamMember.count({ where: { projectId, role: "OWNER" } })) <= 1;
}

/**
 * Runs a change to the team under the project's lock, deciding it on roles read under it: two changes at once (two
 * owners stepping each other down) can't both pass on what each read before the other, and inviting and sending, which
 * check the sender's role under it, can't slip in between. Waits up to a minute, as the lock's other holders do (an
 * import's page, an invite being accepted); still waiting then, nothing changes.
 */
async function underLock<T>(projectId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | Result> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      return fn(tx);
    }, { timeout: 60_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
      return { error: "Something else is changing this project right now. Try again in a minute." };
    }
    throw error;
  }
}

/** `cancelledInvites`: how many of the invites they sent went with the role (only when some did), for the toast to say so. */
export async function changeTeamRole(projectSlug: string, memberId: string, role: string): Promise<Result & { cancelledInvites?: number }> {
  const parsedRole = roleSchema.safeParse(role);
  const pair = await loadPair(projectSlug, memberId);
  if (!parsedRole.success || !pair) {
    return { error: "Team member not found" };
  }
  const { actor, target } = pair;
  const projectId = actor.project.id;
  const newRole = parsedRole.data;
  // The invites they sent for roles they can't give any more go: nobody joins on the strength of a role they've lost.
  const cantGive = (["OWNER", "ADMIN", "MEMBER"] as const).filter((r) => !canAssignRole(newRole, r));
  const result = await underLock(projectId, async (tx): Promise<Result & { cancelledInvites?: number }> => {
    const me = await teamRoleIn(tx, projectId, actor.userId);
    const them = await teamRoleIn(tx, projectId, target.userId);
    if (!them) {
      return { error: "Team member not found" };
    }
    if (!me || !canManageTeamMember(me, them) || !canAssignRole(me, newRole)) {
      return { error: "You don't have permission to make that change" };
    }
    if (newRole !== "OWNER" && (await isLastOwner(tx, projectId, them))) {
      return { error: "A project needs at least one owner. Make someone else an owner first." };
    }
    await tx.teamMember.update({ where: { id: target.id }, data: { role: newRole } });
    const cancelled = await tx.invitation.updateMany({ where: { ...sentPending(projectId, target.userId), role: { in: cantGive } }, data: { revokedAt: new Date() } });
    return cancelled.count > 0 ? { cancelledInvites: cancelled.count } : {};
  });
  refresh();
  return result;
}

/**
 * Takes `userId` off the team, if `actorId` (them, leaving, or whoever removes them) still may; the conversations
 * assigned to them become unassigned, the posts they owned have no owner, and the API keys they created are revoked
 * (they'd stop working anyway, without a role; revoked, they come off Settings → Developers and stay dead if the person
 * is invited back), as are the invites they sent. `refused` says why it may not.
 */
async function removeFromTeam(projectId: string, userId: string, actorId: string, refused: { gone: string; permission: string; lastOwner: string }): Promise<Result> {
  return underLock(projectId, async (tx) => {
    const me = await teamRoleIn(tx, projectId, actorId);
    const them = await teamRoleIn(tx, projectId, userId);
    if (!me || !them) {
      return { error: refused.gone };
    }
    if (actorId !== userId && !canManageTeamMember(me, them)) {
      return { error: refused.permission };
    }
    if (await isLastOwner(tx, projectId, them)) {
      return { error: refused.lastOwner };
    }
    await tx.teamMember.delete({ where: { projectId_userId: { projectId, userId } } });
    await tx.conversation.updateMany({ where: { projectId, assigneeId: userId }, data: { assigneeId: null, heldById: null } });
    await tx.post.updateMany({ where: { projectId, ownerId: userId }, data: { ownerId: null } });
    await tx.apiKey.updateMany({ where: { projectId, createdById: userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.invitation.updateMany({ where: sentPending(projectId, userId), data: { revokedAt: new Date() } });
    return {};
  });
}

/**
 * Invites `userId` sent that could still be accepted. Not an import's still unsent: they're the team's to review, and
 * whoever sends one becomes its sender. Not expired ones: nobody can use them, and Change role's toast counts the rest.
 */
const sentPending = (projectId: string, userId: string) =>
  ({ projectId, createdById: userId, acceptedAt: null, revokedAt: null, sentAt: { not: null }, expiresAt: { gt: new Date() } }) satisfies Prisma.InvitationWhereInput;

export async function removeMember(projectSlug: string, memberId: string): Promise<Result> {
  const pair = await loadPair(projectSlug, memberId);
  if (!pair) {
    return { error: "Team member not found" };
  }
  const { actor, target } = pair;
  const session = await getSession();
  if (target.userId === session?.user.id) {
    return { error: "Use “Leave project” to remove yourself" };
  }
  const result = await removeFromTeam(actor.project.id, target.userId, actor.userId, {
    gone: "Team member not found",
    permission: "You don't have permission to remove this team member",
    lastOwner: "A project needs at least one owner",
  });
  refresh();
  return result;
}

export async function leaveProject(projectSlug: string): Promise<Result> {
  const membership = await getMembership(projectSlug);
  const session = await getSession();
  if (!membership || !session) {
    return { error: "You're not on this project's team" };
  }
  const result = await removeFromTeam(membership.project.id, session.user.id, session.user.id, {
    gone: "You're not on this project's team",
    permission: "You're not on this project's team",
    lastOwner: "You're the only owner. Make someone else an owner before leaving.",
  });
  if (result.error) {
    return result;
  }
  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect("/app");
}
