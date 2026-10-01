import type { TeamRole } from "@tuti/db";

export const ROLE_LABELS: Record<TeamRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  OWNER: "Everything, including managing owners",
  ADMIN: "Settings, SSO and the team",
  MEMBER: "View and work on feedback",
};

export function isAdminRole(role: TeamRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Owners manage everyone. Admins manage admins and members, but can't touch
 * owners or hand out the owner role. Members (the role) manage nobody.
 */
export function canManageTeamMember(actor: TeamRole, target: TeamRole): boolean {
  return actor === "OWNER" || (actor === "ADMIN" && target !== "OWNER");
}

export function canAssignRole(actor: TeamRole, role: TeamRole): boolean {
  return actor === "OWNER" || (actor === "ADMIN" && role !== "OWNER");
}
