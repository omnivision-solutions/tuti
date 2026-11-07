"use server";

import { type Prisma, type TeamRole, prisma } from "@tuti/db";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { canAssignRole, canManageTeamMember } from "@/lib/roles";

import { getMembership } from "./membership";
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

/** A project must always keep at least one owner. */
async function isLastOwner(projectId: string, role: TeamRole): Promise<boolean> {
  if (role !== "OWNER") {
    return false;
  }
  return (await prisma.teamMember.count({ where: { projectId, role: "OWNER" } })) <= 1;
}

/** `cancelledInvites`: how many of the invites they sent went with the role (only when some did), for the toast to say so. */
export async function changeTeamRole(projectSlug: string, memberId: string, role: string): Promise<Result & { cancelledInvites?: number }> {
  const parsedRole = roleSchema.safeParse(role);
  const pair = await loadPair(projectSlug, memberId);
  if (!parsedRole.success || !pair) {
    return { error: "Team member not found" };
  }
  const { actor, target } = pair;
  if (!canManageTeamMember(actor.role, target.role) || !canAssignRole(actor.role, parsedRole.data)) {
    return { error: "You don't have permission to make that change" };
  }
  if (parsedRole.data !== "OWNER" && (await isLastOwner(actor.project.id, target.role))) {
    return { error: "A project needs at least one owner. Make someone else an owner first." };
  }
  // The invites they sent for roles they can't give any more go: nobody joins on the strength of a role they've lost.
  const cantGive = (["OWNER", "ADMIN", "MEMBER"] as const).filter((r) => !canAssignRole(parsedRole.data, r));
  const [, cancelled] = await prisma.$transaction([
    prisma.teamMember.update({ where: { id: target.id }, data: { role: parsedRole.data } }),
    prisma.invitation.updateMany({ where: { ...sentPending(actor.project.id, target.userId), role: { in: cantGive } }, data: { revokedAt: new Date() } }),
  ]);
  refresh();
  return cancelled.count > 0 ? { cancelledInvites: cancelled.count } : {};
}

/**
 * Takes someone off the team; the conversations assigned to them become unassigned, the posts they owned have no
 * owner, and the API keys they created are revoked (they'd stop working anyway, without a role; revoked, they come off
 * Settings → Developers and stay dead if the person is invited back), as are the invites they sent.
 */
async function removeFromTeam(projectId: string, userId: string, member: Prisma.TeamMemberWhereUniqueInput) {
  await prisma.$transaction([
    prisma.teamMember.delete({ where: member }),
    prisma.conversation.updateMany({ where: { projectId, assigneeId: userId }, data: { assigneeId: null, heldById: null } }),
    prisma.post.updateMany({ where: { projectId, ownerId: userId }, data: { ownerId: null } }),
    prisma.apiKey.updateMany({ where: { projectId, createdById: userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.invitation.updateMany({ where: sentPending(projectId, userId), data: { revokedAt: new Date() } }),
  ]);
}

/** Invites `userId` sent that nobody has used yet. Not an import's still unsent: they're the team's to review, and whoever sends one becomes its sender. */
const sentPending = (projectId: string, userId: string) =>
  ({ projectId, createdById: userId, acceptedAt: null, revokedAt: null, sentAt: { not: null } }) satisfies Prisma.InvitationWhereInput;

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
  if (!canManageTeamMember(actor.role, target.role)) {
    return { error: "You don't have permission to remove this team member" };
  }
  if (await isLastOwner(actor.project.id, target.role)) {
    return { error: "A project needs at least one owner" };
  }
  await removeFromTeam(actor.project.id, target.userId, { id: target.id });
  refresh();
  return {};
}

export async function leaveProject(projectSlug: string): Promise<Result> {
  const membership = await getMembership(projectSlug);
  const session = await getSession();
  if (!membership || !session) {
    return { error: "You're not on this project's team" };
  }
  if (await isLastOwner(membership.project.id, membership.role)) {
    return { error: "You're the only owner. Make someone else an owner before leaving." };
  }
  await removeFromTeam(membership.project.id, session.user.id, {
    projectId_userId: { projectId: membership.project.id, userId: session.user.id },
  });
  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect("/app");
}
