import type { MemberRole } from "@tuti/db";

export const ROLE_LABELS: Record<MemberRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  OWNER: "Everything, including managing owners",
  ADMIN: "Settings, SSO and members",
  MEMBER: "View and work on feedback",
};

export function isAdminRole(role: MemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Owners manage everyone. Admins manage admins and members, but can't touch
 * owners or hand out the owner role. Members manage nobody.
 */
export function canManageMember(actor: MemberRole, target: MemberRole): boolean {
  return actor === "OWNER" || (actor === "ADMIN" && target !== "OWNER");
}

export function canAssignRole(actor: MemberRole, role: MemberRole): boolean {
  return actor === "OWNER" || (actor === "ADMIN" && role !== "OWNER");
}
