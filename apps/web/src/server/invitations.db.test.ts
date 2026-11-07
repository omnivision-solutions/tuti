import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DAILY_INVITE_LIMIT, hashInvitationToken } from "@tuti/jobs";
import { actAs, addMember, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { pendingInvitationsFor } from "./invitation-lookup";
import { acceptInvitation, acceptInvitationById, createInvitation, declineInvitation } from "./invitations";
import { changeTeamRole, leaveProject, removeMember } from "./team";

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
  }, 20_000);

  test("admins can't invite owners", async () => {
    const admin = await addMember(project.id, "ADMIN");
    actAs(admin);
    expect(await createInvitation(project.slug, newEmail(), "OWNER")).toEqual({
      error: "You can't invite people with that role",
    });
  });

  test("admins can't replace an owner's pending owner invite by inviting the address again", async () => {
    const email = newEmail();
    const ownerInvite = await createInvitation(project.slug, email, "OWNER");
    const admin = await addMember(project.id, "ADMIN");
    actAs(admin);
    expect(await createInvitation(project.slug, email, "MEMBER")).toEqual({
      error: `${email} has a pending owner invite. Only owners can change it.`,
    });

    actAs(await signUp("Ivy", email));
    expect(await redirectTarget(acceptInvitation(tokenOf(ownerInvite.url!)))).toBe(`/app/${project.slug}`);
  });

  test("once an owner's owner invite has expired, admins can invite that address again", async () => {
    const email = newEmail();
    await createInvitation(project.slug, email, "OWNER");
    await prisma.invitation.updateMany({ where: { projectId: project.id, email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    actAs(await addMember(project.id, "ADMIN"));
    expect(await createInvitation(project.slug, email, "MEMBER")).toMatchObject({ emailSent: true });
  });
});

describe("invites someone sent go when they can't give that role any more", () => {
  const sendAs = async (role: "OWNER" | "ADMIN") => {
    if (role === "OWNER") {
      await addMember(project.id, "OWNER"); // so the sender isn't the only owner
    }
    const sender = await addMember(project.id, role);
    actAs(sender);
    const email = newEmail();
    const { url } = await createInvitation(project.slug, email, role);
    actAs(owner);
    const accept = async () => {
      const invitee = await signUp("Ivy", email);
      actAs(invitee);
      return acceptInvitation(tokenOf(url!)).catch((error: unknown) => error);
    };
    return { sender, accept };
  };
  const gone = { error: "This invite has expired, was revoked, or was already used" };

  test("removed from the team", async () => {
    const { sender, accept } = await sendAs("ADMIN");
    expect(await removeMember(project.slug, sender.memberId)).toEqual({});
    expect(await prisma.invitation.count({ where: { createdById: sender.id, revokedAt: null } })).toBe(0);
    expect(await accept()).toEqual(gone);
  });

  test("an owner removed", async () => {
    const { sender, accept } = await sendAs("OWNER");
    expect(await removeMember(project.slug, sender.memberId)).toEqual({});
    expect(await accept()).toEqual(gone);
  });

  test("left the project", async () => {
    const { sender, accept } = await sendAs("ADMIN");
    actAs(sender);
    expect(await redirectTarget(leaveProject(project.slug))).toBe("/app");
    expect(await accept()).toEqual(gone);
  });

  test("an admin made a member", async () => {
    const { sender, accept } = await sendAs("ADMIN");
    // One they sent has expired already: nobody can use it, so it isn't counted as cancelled.
    actAs(sender);
    const expired = newEmail();
    await createInvitation(project.slug, expired, "MEMBER");
    await prisma.invitation.updateMany({ where: { projectId: project.id, email: expired }, data: { expiresAt: new Date(Date.now() - 1000) } });
    actAs(owner);
    expect(await changeTeamRole(project.slug, sender.memberId, "MEMBER")).toEqual({ cancelledInvites: 1 });
    expect(await prisma.invitation.count({ where: { createdById: sender.id, revokedAt: null, expiresAt: { gt: new Date() } } })).toBe(0);
    expect(await accept()).toEqual(gone);
  });

  test("an owner made an admin: their owner invites go, their admin and member invites stay", async () => {
    const { sender, accept } = await sendAs("OWNER");
    actAs(sender);
    const memberInvite = await createInvitation(project.slug, newEmail(), "MEMBER");
    actAs(owner);
    expect(await changeTeamRole(project.slug, sender.memberId, "ADMIN")).toEqual({ cancelledInvites: 1 });
    expect(await prisma.invitation.count({ where: { createdById: sender.id, role: "OWNER", revokedAt: null } })).toBe(0);
    expect(await prisma.invitation.findUnique({ where: { tokenHash: hashInvitationToken(tokenOf(memberInvite.url!)) }, select: { revokedAt: true } })).toEqual({ revokedAt: null });
    expect(await accept()).toEqual(gone);
  });

  test("checked again when it's accepted, whatever revoked it or not", async () => {
    const { sender, accept } = await sendAs("ADMIN");
    // Demoted some other way than Team & roles: the invite is still pending, but can't be used.
    await prisma.teamMember.update({ where: { id: sender.memberId }, data: { role: "MEMBER" } });
    expect(await accept()).toEqual(gone);
  });
});

describe("accepting", () => {
  test("only the invited address can accept, and accepting doesn't verify it", async () => {
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
    // The link is shown to whoever invited them too, so having it isn't proof of the inbox.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).emailVerified).toBe(false);
  });

  test("signing up with an address and accepting an invite to it from your own other account doesn't verify it", async () => {
    const email = newEmail();
    // Another project's invite to that address, waiting for whoever owns it.
    await createInvitation(project.slug, email, "ADMIN");
    const inviter = await signUp("Sam");
    const theirs = await createProject(inviter);
    actAs(inviter);
    const { url } = await createInvitation(theirs.slug, email, "MEMBER");
    const squatter = await signUp("Sam Again", email);
    actAs(squatter);
    expect(await redirectTarget(acceptInvitation(tokenOf(url!)))).toBe(`/app/${theirs.slug}`);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: squatter.id } });
    expect(after.emailVerified).toBe(false);
    expect(await pendingInvitationsFor(after)).toEqual([]);
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
  const FULL = "Projects on the Free plan have up to 3 team members, invites included. Upgrade to Pro in Settings → Billing to invite more.";

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

  test("an invite link with no address takes a place too", async () => {
    await addMember(project.id, "MEMBER");
    await prisma.invitation.create({
      data: { projectId: project.id, tokenHash: hashInvitationToken(crypto.randomUUID()), createdById: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await createInvitation(project.slug, newEmail(), "MEMBER")).toEqual({ error: FULL });
  });

  test("two invites at once for the last place: only one is sent", async () => {
    await addMember(project.id, "MEMBER");
    const results = await Promise.all([createInvitation(project.slug, newEmail(), "MEMBER"), createInvitation(project.slug, newEmail(), "MEMBER")]);
    expect(results.filter((result) => result.error === FULL)).toHaveLength(1);
    expect(await prisma.invitation.count({ where: { projectId: project.id, revokedAt: null } })).toBe(1);
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
