import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { actAs, addMember, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import { changeTeamRole, leaveProject, removeMember } from "./team";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let ownerMemberId: string;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  ownerMemberId = project.team[0]!.id;
});

const roleOf = async (memberId: string) =>
  (await prisma.teamMember.findUnique({ where: { id: memberId }, select: { role: true } }))?.role;

describe("a project keeps at least one owner", () => {
  test("the only owner can't step down or leave", async () => {
    actAs(owner);
    expect(await changeTeamRole(project.slug, ownerMemberId, "ADMIN")).toEqual({
      error: "A project needs at least one owner. Make someone else an owner first.",
    });
    expect(await leaveProject(project.slug)).toEqual({
      error: "You're the only owner. Make someone else an owner before leaving.",
    });
    expect(await roleOf(ownerMemberId)).toBe("OWNER");
  });

  test("with a second owner, an owner can step down or leave", async () => {
    const second = await addMember(project.id, "OWNER");
    actAs(owner);
    expect(await changeTeamRole(project.slug, ownerMemberId, "ADMIN")).toEqual({});
    expect(await roleOf(ownerMemberId)).toBe("ADMIN");

    actAs(second);
    expect(await changeTeamRole(project.slug, ownerMemberId, "OWNER")).toEqual({});
    actAs(owner);
    expect(await redirectTarget(leaveProject(project.slug))).toBe("/app");
    expect(await roleOf(ownerMemberId)).toBeUndefined();
  });
});

describe("only owners manage owners", () => {
  test("an admin can't make anyone an owner or touch an owner", async () => {
    const admin = await addMember(project.id, "ADMIN");
    const member = await addMember(project.id, "MEMBER");
    actAs(admin);
    expect(await changeTeamRole(project.slug, member.memberId, "OWNER")).toEqual({
      error: "You don't have permission to make that change",
    });
    expect(await changeTeamRole(project.slug, ownerMemberId, "MEMBER")).toEqual({
      error: "You don't have permission to make that change",
    });
    expect(await removeMember(project.slug, ownerMemberId)).toEqual({
      error: "You don't have permission to remove this team member",
    });
    expect(await roleOf(member.memberId)).toBe("MEMBER");
    expect(await roleOf(ownerMemberId)).toBe("OWNER");
  });

  test("an admin manages admins and members", async () => {
    const admin = await addMember(project.id, "ADMIN");
    const member = await addMember(project.id, "MEMBER");
    actAs(admin);
    expect(await changeTeamRole(project.slug, member.memberId, "ADMIN")).toEqual({});
    expect(await removeMember(project.slug, member.memberId)).toEqual({});
    expect(await roleOf(member.memberId)).toBeUndefined();
  });

  test("a member manages nobody", async () => {
    const member = await addMember(project.id, "MEMBER");
    const other = await addMember(project.id, "MEMBER");
    actAs(member);
    expect(await changeTeamRole(project.slug, other.memberId, "ADMIN")).toEqual({
      error: "You don't have permission to make that change",
    });
    expect(await removeMember(project.slug, other.memberId)).toEqual({
      error: "You don't have permission to remove this team member",
    });
  });
});

test("team members leave with “Leave project”, not by removing themselves", async () => {
  const second = await addMember(project.id, "OWNER");
  actAs(owner);
  expect(await removeMember(project.slug, ownerMemberId)).toEqual({ error: "Use “Leave project” to remove yourself" });
  expect(await roleOf(second.memberId)).toBe("OWNER");
});

test("nobody outside the team can change it", async () => {
  const outsider = await signUp("Outsider");
  await createProject(outsider);
  for (const user of [null, outsider]) {
    actAs(user);
    expect(await changeTeamRole(project.slug, ownerMemberId, "MEMBER")).toEqual({ error: "Team member not found" });
    expect(await removeMember(project.slug, ownerMemberId)).toEqual({ error: "Team member not found" });
  }
  expect(await roleOf(ownerMemberId)).toBe("OWNER");
});
