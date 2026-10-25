import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DAILY_INVITE_LIMIT, hashInvitationToken } from "@/lib/invitations";
import { actAs, addMember, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { pendingInvitationsFor } from "./invitation-lookup";
import { acceptInvitation, acceptInvitationById, createInvitation, declineInvitation } from "./invitations";

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
    // Replies reach the person who sent the invite.
    expect(message.replyTo).toBe(owner.email);
    expect(message.from).toMatch(/Tuti Test.*<test@example.com>/);
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

describe("pending invitations on the dashboard", () => {
  const verify = (user: TestUser) => prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  const pendingFor = async (user: TestUser) =>
    pendingInvitationsFor({ ...(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })) });

  test("are listed only for the verified address they were sent to", async () => {
    const email = newEmail();
    await createInvitation(project.slug, email, "ADMIN");
    const invitee = await signUp("Ivy", email);
    const someoneElse = await signUp("Mallory");
    await verify(someoneElse);

    expect(await pendingFor(invitee)).toEqual([]); // not verified yet
    expect(await pendingFor(someoneElse)).toEqual([]);
    await verify(invitee);
    expect(await pendingFor(invitee)).toEqual([
      expect.objectContaining({ role: "ADMIN", project: { name: project.name }, createdBy: { name: "Olive Owner" } }),
    ]);
  });

  test("accepting joins the team; unverified or other accounts can't", async () => {
    const email = newEmail();
    await createInvitation(project.slug, email, "MEMBER");
    const invitee = await signUp("Ivy", email);
    const [invitation] = await prisma.invitation.findMany({ where: { email } });
    const someoneElse = await signUp("Mallory");
    await verify(someoneElse);

    actAs(invitee);
    expect(await acceptInvitationById(invitation!.id)).toEqual({ error: "Invite not found" }); // unverified
    actAs(someoneElse);
    expect(await acceptInvitationById(invitation!.id)).toEqual({ error: "Invite not found" });
    expect(await declineInvitation(invitation!.id)).toEqual({ error: "Invite not found" });

    await verify(invitee);
    actAs(invitee);
    expect(await redirectTarget(acceptInvitationById(invitation!.id))).toBe(`/app/${project.slug}`);
    expect(await isMember(invitee.id)).toBe(true);
    expect(await pendingFor(invitee)).toEqual([]);
  });

  test("declining ends the invite", async () => {
    const email = newEmail();
    const { url } = await createInvitation(project.slug, email, "MEMBER");
    const invitee = await signUp("Ivy", email);
    await verify(invitee);
    const [invitation] = await pendingFor(invitee);

    actAs(invitee);
    expect(await declineInvitation(invitation!.id)).toEqual({});
    expect(await pendingFor(invitee)).toEqual([]);
    expect(await acceptInvitation(tokenOf(url!))).toEqual({
      error: "This invite has expired, was revoked, or was already used",
    });
    expect(await isMember(invitee.id)).toBe(false);
  });
});

describe("on the free plan (where plans are sold)", () => {
  beforeEach(() => {
    vi.stubEnv("PLANS", "on");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const FULL = "Projects on the free plan have up to 3 team members, invites included. Upgrade to Pro in Settings → Billing to invite more.";

  test("3 team members, invites still pending included; a new invite to the same address still replaces its own", async () => {
    await addMember(project.id, "MEMBER");
    const pending = newEmail();
    expect(await createInvitation(project.slug, pending, "MEMBER")).toMatchObject({ emailSent: true });
    expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toEqual({ error: FULL });
    expect(await createInvitation(project.slug, pending, "ADMIN")).toMatchObject({ emailSent: true });
    // On Pro, no limit.
    await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
    expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toMatchObject({ emailSent: true });
  });

  test("a project that dropped to Free keeps its team, but an invite sent before can't take a place it no longer has", async () => {
    await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
    const email = newEmail();
    const { url } = await createInvitation(project.slug, email, "MEMBER");
    await addMember(project.id, "MEMBER");
    await addMember(project.id, "MEMBER");
    await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
    const invitee = await signUp("Ivy", email);
    actAs(invitee);
    expect(await acceptInvitation(tokenOf(url!))).toEqual({
      error: "This project's team is full on its plan. Ask one of its owners to upgrade it, then try again.",
    });
    expect(await isMember(invitee.id)).toBe(false);
    expect(await prisma.teamMember.count({ where: { projectId: project.id } })).toBe(3);
    // The invite is still there: it works once the plan is back.
    await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
    expect(await redirectTarget(acceptInvitation(tokenOf(url!)))).toBe(`/app/${project.slug}`);
  });

  test("self-hosted (no plans), no limit", async () => {
    vi.stubEnv("PLANS", "");
    for (let i = 0; i < 3; i++) {
      await addMember(project.id, "MEMBER");
    }
    expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toMatchObject({ emailSent: true });
  });
});
