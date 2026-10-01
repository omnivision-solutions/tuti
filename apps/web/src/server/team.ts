"use server";

import { type TeamRole, prisma } from "@tuti/db";
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

export async function changeTeamRole(projectSlug: string, memberId: string, role: string): Promise<Result> {
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
  await prisma.teamMember.update({ where: { id: target.id }, data: { role: parsedRole.data } });
  refresh();
  return {};
}

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
  await prisma.teamMember.delete({ where: { id: target.id } });
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
  await prisma.teamMember.delete({
    where: { projectId_userId: { projectId: membership.project.id, userId: session.user.id } },
  });
  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect("/app");
}
