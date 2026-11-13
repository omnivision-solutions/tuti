import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { emailsThisMonth, handlers, resumeToken } from "@tuti/jobs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { createComment, createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { resumeEmailSending } from "./email-pause";
import { emailSignInLink } from "./sign-in-link";

/**
 * A plan's monthly email limit (emailsPerMonth; packages/jobs/src/email-limits.ts): a project's email to its users is
 * counted each calendar month (UTC); past its plan's limit it waits for the next month, and its owners and admins are
 * told once.
 */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };

// Mid-month, so a test run near a month's end can't straddle two months.
const MID_MONTH = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 12));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: MID_MONTH });
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  // Free sends 1 email a month.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 1; }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const emailsTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));
const limitEmails = (address: string) => emailsTo(address).filter((email) => email.subject.endsWith("reached its monthly email limit"));
const month = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** A project past its first week (no daily cap), with a verified owner. */
async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  return { owner, project, team };
}

/** Two conversations by email, each with a reply a minute old. */
async function twoReplies(project: { id: string; slug: string }, team: { actor: { kind: "user"; userId: string }; projectId: string }) {
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const people = [`e2e-kim-${project.slug}@example.com`, `e2e-lee-${project.slug}@example.com`];
  for (const [n, from] of people.entries()) {
    await postEmail(rawEmail({ from, to: address, subject: "Invoice missing" }), { recipient: address });
    await call(replyToConversation, team, { number: n + 1, body: "It's under Billing." });
  }
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
  return () => people.filter((person) => emailsTo(person).length > 0).length;
}

test("past the plan's monthly limit, replies are saved but their email waits; the owner is told once; next month they go", async () => {
  const { owner, project, team } = await setup();
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  // Both replies are saved; the second's email waits.
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM" } })).toBe(2);
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM", emailStatus: null } })).toBe(1);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });

  // The owner hears once, naming the plan with more room and Billing.
  const [told] = limitEmails(owner.email);
  expect(told?.text).toContain("Upgrade to Pro for more.");
  expect(told?.text).toContain(`/app/${project.slug}/settings/billing`);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  expect(limitEmails(owner.email)).toHaveLength(1);

  // A sign-in link isn't counted, and still goes.
  actAs(null);
  const reader = `e2e-signin-${project.slug}@example.com`;
  const form = new FormData();
  form.set("email", reader);
  await emailSignInLink(project.slug, "/", form);
  expect(emailsTo(reader)).toHaveLength(1);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });

  // Next month, the rest go.
  vi.setSystemTime(nextMonth());
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });
});

/** A post with two verified voters. */
async function votedPost(project: { id: string }) {
  const voters = [await signUp("Val Voter"), await signUp("Vic Voter")];
  await prisma.user.updateMany({ where: { id: { in: voters.map((v) => v.id) } }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voters[0]!.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await call(setVote, { actor: { kind: "user", userId: voters[1]!.id }, projectId: project.id }, { number: post.number, voted: true });
  return { voters, post };
}

test("shipped emails past the limit are due again next month, and go then", async () => {
  const { project, team } = await setup();
  const { voters, post } = await votedPost(project);
  await call(updatePost, team, { number: post.number, status: "completed" });
  const shipped = () => voters.filter((voter) => emailsTo(voter.email).some((email) => email.subject.startsWith("Done:"))).length;
  expect(shipped()).toBe(1);
  const { id: postId, shippedEmailsDueAt } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true, shippedEmailsDueAt: true } });
  // Due from next month: the safety net (which looks back a day) finds it once the month resets.
  expect(shippedEmailsDueAt).toEqual(nextMonth());

  // The month resets (its count is last month's).
  await prisma.projectEmailMonth.updateMany({ where: { projectId: project.id, month: month() }, data: { month: new Date(Date.UTC(2020, 0, 1)) } });
  await handlers.postShipped({ postId }, log);
  expect(shipped()).toBe(2);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt).toBeNull();
});

test("a team's reply emailed to voters past the limit is due next month; an upgrade lets it go before then", async () => {
  const { project, team } = await setup();
  const { voters, post } = await votedPost(project);
  await call(createComment, team, { number: post.number, body: "It's out.", emailVoters: true });
  const replied = () => voters.filter((voter) => emailsTo(voter.email).some((email) => email.subject === "Re: Dark mode")).length;
  expect(replied()).toBe(1);
  const comment = () => prisma.comment.findFirstOrThrow({ where: { projectId: project.id }, select: { votersEmailDueAt: true } });
  expect((await comment()).votersEmailDueAt).toEqual(nextMonth());

  // Still capped: the safety net leaves it.
  await handlers.resubmitReplyEmails({}, log);
  expect(replied()).toBe(1);
  // Upgraded, the safety net finds it, though it's due next month.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  await handlers.resubmitReplyEmails({}, log);
  expect(replied()).toBe(2);
  expect((await comment()).votersEmailDueAt).toBeNull();
});

test("a reply that isn't emailed after all (nobody to email) doesn't count", async () => {
  const { project, team } = await setup();
  await twoReplies(project, team);
  await prisma.emailBlock.createMany({ data: [`e2e-kim-${project.slug}@example.com`, `e2e-lee-${project.slug}@example.com`].map((email) => ({ projectId: project.id, email })) });
  await handlers.sendConversationReplies({}, log);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 0, limit: 1 });
});

test("the owner hears when the month's last email goes, though what waits comes in a later run", async () => {
  const { owner, project, team } = await setup();
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const reply = async (n: number, from: string) => {
    await postEmail(rawEmail({ from, to: address, subject: "Invoice missing" }), { recipient: address });
    await call(replyToConversation, team, { number: n, body: "It's under Billing." });
    await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
    await handlers.sendConversationReplies({}, log);
  };
  await reply(1, `e2e-kim-${project.slug}@example.com`);
  expect(limitEmails(owner.email)).toHaveLength(1);
  await reply(2, `e2e-lee-${project.slug}@example.com`);
  expect(emailsTo(`e2e-lee-${project.slug}@example.com`)).toHaveLength(0);
  expect(limitEmails(owner.email)).toHaveLength(1);
});

test("a send that fails gives its slot back: the month counts what was sent", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 5; }));
  const { project, team } = await setup();
  const emailed = await twoReplies(project, team);
  mailbox.refuseNext(`e2e-kim-${project.slug}@example.com`);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 5 });
});

test("a full project's email due now (its job never ran) is moved to next month by the safety nets, never left behind; a paused one's isn't", async () => {
  const { project, team } = await setup();
  await votedPost(project);
  await prisma.projectEmailMonth.create({ data: { projectId: project.id, month: month(), emails: 1 } });
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  const late = new Date(Date.now() - 15 * 60_000);
  const comment = await prisma.comment.create({ data: { projectId: project.id, postId, authorId: team.actor.userId, body: "It's out.", votersEmailDueAt: late } });
  await prisma.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: late } });
  const due = async () => [
    (await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).votersEmailDueAt,
    (await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt,
  ];

  // Paused: left as it is, for the resume.
  vi.stubEnv("APP_PORTAL_OWNER", "e2e-operator@example.com");
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date(), emailPausedReason: "2.0% of emails bounced" } });
  await handlers.resubmitReplyEmails({}, log);
  await handlers.resubmitShippedEmails({}, log);
  expect(await due()).toEqual([late, late]);

  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: null, emailPausedReason: null } });
  await handlers.resubmitReplyEmails({}, log);
  await handlers.resubmitShippedEmails({}, log);
  expect(await due()).toEqual([nextMonth(), nextMonth()]);
});

test("resuming a paused project keeps the email the monthly limit holds for next month", async () => {
  const { project, team } = await setup();
  const { post } = await votedPost(project);
  await call(updatePost, team, { number: post.number, status: "completed" });
  const due = () => prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { shippedEmailsDueAt: true } });
  expect((await due()).shippedEmailsDueAt).toEqual(nextMonth());
  const pausedAt = new Date(Date.now() - 60_000);
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: pausedAt, emailPausedReason: "2.0% of emails bounced" } });
  expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
  expect((await due()).shippedEmailsDueAt).toEqual(nextMonth());
});

test("a plan with no limit counts but never holds; an upgrade lets the waiting email go", async () => {
  const { project, team } = await setup();
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 2, limit: null });
});

test("on a server that doesn't sell plans (self-hosted), nothing is counted or held", async () => {
  vi.stubEnv("BILLING_CONFIG", "");
  const { owner, project, team } = await setup();
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
  expect(await emailsThisMonth(project.id)).toBeNull();
  expect(await prisma.projectEmailMonth.count({ where: { projectId: project.id } })).toBe(0);
  expect(limitEmails(owner.email)).toHaveLength(0);
});
