import { expect, test } from "vitest";

import { canAssignRole, canManageTeamMember, isAdminRole } from "./roles";

const ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;

test("only owners and admins are admins", () => {
  expect(ROLES.filter(isAdminRole)).toEqual(["OWNER", "ADMIN"]);
});

test.each([
  ["OWNER", ["OWNER", "ADMIN", "MEMBER"]],
  ["ADMIN", ["ADMIN", "MEMBER"]],
  ["MEMBER", []],
] as const)("%s manages %j and assigns the same roles", (actor, allowed) => {
  expect(ROLES.filter((target) => canManageTeamMember(actor, target))).toEqual(allowed);
  expect(ROLES.filter((role) => canAssignRole(actor, role))).toEqual(allowed);
});
