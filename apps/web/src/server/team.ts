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

/** The acting member and the member being changed, both in this workspace. */
async function loadPair(workspaceSlug: string, memberId: string) {
  const actor = await getMembership(workspaceSlug);
  if (!actor) {
    return null;
  }
  const target = await prisma.member.findFirst({
    where: { id: memberId, workspaceId: actor.workspace.id },
    select: { id: true, role: true, userId: true },
  });
  return target ? { actor, target } : null;
}

/** A workspace must always keep at least one owner. */
async function isLastOwner(workspaceId: string, role: MemberRole): Promise<boolean> {
  if (role !== "OWNER") {
    return false;
  }
  return (await prisma.member.count({ where: { workspaceId, role: "OWNER" } })) <= 1;
}

export async function changeMemberRole(workspaceSlug: string, memberId: string, role: string): Promise<Result> {
  const parsedRole = roleSchema.safeParse(role);
  const pair = await loadPair(workspaceSlug, memberId);
  if (!parsedRole.success || !pair) {
    return { error: "Member not found" };
  }
  const { actor, target } = pair;
  if (!canManageMember(actor.role, target.role) || !canAssignRole(actor.role, parsedRole.data)) {
    return { error: "You don't have permission to make that change" };
  }
  if (parsedRole.data !== "OWNER" && (await isLastOwner(actor.workspace.id, target.role))) {
    return { error: "A workspace needs at least one owner. Make someone else an owner first." };
  }
  await prisma.member.update({ where: { id: target.id }, data: { role: parsedRole.data } });
  refresh();
  return {};
}

export async function removeMember(workspaceSlug: string, memberId: string): Promise<Result> {
  const pair = await loadPair(workspaceSlug, memberId);
  if (!pair) {
    return { error: "Member not found" };
  }
  const { actor, target } = pair;
  const session = await getSession();
  if (target.userId === session?.user.id) {
    return { error: "Use “Leave workspace” to remove yourself" };
  }
  if (!canManageMember(actor.role, target.role)) {
    return { error: "You don't have permission to remove this member" };
  }
  if (await isLastOwner(actor.workspace.id, target.role)) {
    return { error: "A workspace needs at least one owner" };
  }
  await prisma.member.delete({ where: { id: target.id } });
  refresh();
  return {};
}

export async function leaveWorkspace(workspaceSlug: string): Promise<Result> {
  const membership = await getMembership(workspaceSlug);
  const session = await getSession();
  if (!membership || !session) {
    return { error: "You're not a member of this workspace" };
  }
  if (await isLastOwner(membership.workspace.id, membership.role)) {
    return { error: "You're the only owner. Make someone else an owner before leaving." };
  }
  await prisma.member.delete({
    where: { workspaceId_userId: { workspaceId: membership.workspace.id, userId: session.user.id } },
  });
  redirect("/app");
}
