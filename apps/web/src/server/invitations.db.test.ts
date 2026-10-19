import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { DAILY_INVITE_LIMIT, hashInvitationToken } from "@/lib/invitations";
import { actAs, addMember, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { acceptInvitation, createInvitation } from "./invitations";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const newEmail = () => `e2e-${randomUUID()}@example.com`;
const tokenOf = (url: string) => url.split("/invite/")[1]!;
const isMember = async (userId: string) =>
  (await prisma.teamMember.count({ where: { projectId: project.id, userId } })) === 1;

describe("inviting by email", () => {
  test("emails the invite; the link is also returned to copy", async () => {
    const email = newEmail();
    const result = await createInvitation(project.slug, email, "ADMIN");
    expect(result).toMatchObject({ emailSent: true, url: expect.stringMatching(/\/invite\/[\w-]+$/) });

    const message = await mailbox.latestTo(email);
    expect(message.subject).toBe(`Olive Owner invited you to ${project.name} on Tuti`);
    expect(message.text).toContain(`join ${project.name} on Tuti as an admin`);
    expect(message.text).toContain(result.url);
  });

  test("addresses are stored in lowercase", async () => {
    const email = newEmail();
    await createInvitation(project.slug, `  ${email.toUpperCase()} `, "MEMBER");
    expect(await prisma.invitation.count({ where: { projectId: project.id, email } })).toBe(1);
  });

  test("a new invite to the same address replaces the pending one", async () => {
    const email = newEmail();
    const first = await createInvitation(project.slug, email, "MEMBER");
    const second = await createInvitation(project.slug, email, "ADMIN");
    const invitee = await signUp("Ivy", email);

    actAs(invitee);
    expect(await acceptInvitation(tokenOf(first.url!))).toEqual({
      error: "This invite has expired, was revoked, or was already used",
    });
    expect(await redirectTarget(acceptInvitation(tokenOf(second.url!)))).toBe(`/app/${project.slug}`);
    expect(await prisma.teamMember.findFirst({ where: { userId: invitee.id }, select: { role: true } })).toEqual({
      role: "ADMIN",
    });
  });

  test("refuses people already on the team, bad addresses and too many invites", async () => {
    const member = await addMember(project.id, "MEMBER");
    expect(await createInvitation(project.slug, member.email.toUpperCase(), "MEMBER")).toEqual({
      error: `${member.email} is already on the team`,
    });
    expect(await createInvitation(project.slug, "not an email", "MEMBER")).toEqual({
      error: "Enter a valid email address",
    });

    const sentToday = await prisma.invitation.count({ where: { projectId: project.id } });
    for (let i = sentToday; i < DAILY_INVITE_LIMIT; i++) {
      expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toMatchObject({ emailSent: true });
    }
    expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toEqual({
      error: `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.`,
    });
  });

  test("admins can't invite owners", async () => {
    const admin = await addMember(project.id, "ADMIN");
    actAs(admin);
    expect(await createInvitation(project.slug, newEmail(), "OWNER")).toEqual({
      error: "You can't invite people with that role",
    });
  });
});

describe("accepting", () => {
  test("only the invited address can accept, and accepting verifies it", async () => {
    const email = newEmail();
    const { url } = await createInvitation(project.slug, email, "MEMBER");
    const someoneElse = await signUp("Mallory");
    const invitee = await signUp("Ivy", email);

    actAs(someoneElse);
    expect(await acceptInvitation(tokenOf(url!))).toEqual({
      error: `This invite is for ${email}. Sign in with that email to accept it.`,
    });
    expect(await isMember(someoneElse.id)).toBe(false);

    actAs(invitee);
    expect(await redirectTarget(acceptInvitation(tokenOf(url!)))).toBe(`/app/${project.slug}`);
    expect(await isMember(invitee.id)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).emailVerified).toBe(true);
  });

  test("older link-only invites still work for whoever has the link", async () => {
    const token = randomUUID();
    await prisma.invitation.create({
      data: {
        projectId: project.id,
        tokenHash: hashInvitationToken(token),
        createdById: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const anyone = await signUp("Anyone");
    actAs(anyone);
    expect(await redirectTarget(acceptInvitation(token))).toBe(`/app/${project.slug}`);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: anyone.id } })).emailVerified).toBe(false);
  });
});
