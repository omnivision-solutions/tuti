"use server";

import { type MemberRole, prisma } from "@tuti/db";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { canAssignRole, canManageMember } from "@/lib/roles";

import { getMembership } from "./members";
import { getSession } from "./session";

type Result = { error?: string };

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

/** The acting member and the member being changed, both in this project. */
async function loadPair(projectSlug: string, memberId: string) {
  const actor = await getMembership(projectSlug);
  if (!actor) {
    return null;
  }
  const target = await prisma.member.findFirst({
    where: { id: memberId, projectId: actor.project.id },
    select: { id: true, role: true, userId: true },
  });
  return target ? { actor, target } : null;
}

/** A project must always keep at least one owner. */
async function isLastOwner(projectId: string, role: MemberRole): Promise<boolean> {
  if (role !== "OWNER") {
    return false;
  }
  return (await prisma.member.count({ where: { projectId, role: "OWNER" } })) <= 1;
}

export async function changeMemberRole(projectSlug: string, memberId: string, role: string): Promise<Result> {
  const parsedRole = roleSchema.safeParse(role);
  const pair = await loadPair(projectSlug, memberId);
  if (!parsedRole.success || !pair) {
    return { error: "Member not found" };
  }
  const { actor, target } = pair;
  if (!canManageMember(actor.role, target.role) || !canAssignRole(actor.role, parsedRole.data)) {
    return { error: "You don't have permission to make that change" };
  }
  if (parsedRole.data !== "OWNER" && (await isLastOwner(actor.project.id, target.role))) {
    return { error: "A project needs at least one owner. Make someone else an owner first." };
  }
  await prisma.member.update({ where: { id: target.id }, data: { role: parsedRole.data } });
  refresh();
  return {};
}

export async function removeMember(projectSlug: string, memberId: string): Promise<Result> {
  const pair = await loadPair(projectSlug, memberId);
  if (!pair) {
    return { error: "Member not found" };
  }
  const { actor, target } = pair;
  const session = await getSession();
  if (target.userId === session?.user.id) {
    return { error: "Use “Leave project” to remove yourself" };
  }
  if (!canManageMember(actor.role, target.role)) {
    return { error: "You don't have permission to remove this member" };
  }
  if (await isLastOwner(actor.project.id, target.role)) {
    return { error: "A project needs at least one owner" };
  }
  await prisma.member.delete({ where: { id: target.id } });
  refresh();
  return {};
}

export async function leaveProject(projectSlug: string): Promise<Result> {
  const membership = await getMembership(projectSlug);
  const session = await getSession();
  if (!membership || !session) {
    return { error: "You're not a member of this project" };
  }
  if (await isLastOwner(membership.project.id, membership.role)) {
    return { error: "You're the only owner. Make someone else an owner before leaving." };
  }
  await prisma.member.delete({
    where: { projectId_userId: { projectId: membership.project.id, userId: session.user.id } },
  });
  redirect("/app");
}
