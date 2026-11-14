import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { claimProjectEmail, emailsThisMonth, handlers, resumeToken } from "@tuti/jobs";
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

test("the owner hears once an email waits, not when the last one goes, though what waits comes in a later run", async () => {
  const { owner, project, team } = await setup();
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const reply = async (n: number, from: string) => {
    await postEmail(rawEmail({ from, to: address, subject: "Invoice missing" }), { recipient: address });
    await call(replyToConversation, team, { number: n, body: "It's under Billing." });
    await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
    await handlers.sendConversationReplies({}, log);
  };
  await reply(1, `e2e-kim-${project.slug}@example.com`);
  // The month's last went: nothing waits yet.
  expect(limitEmails(owner.email)).toHaveLength(0);
  await reply(2, `e2e-lee-${project.slug}@example.com`);
  expect(emailsTo(`e2e-lee-${project.slug}@example.com`)).toHaveLength(0);
  expect(limitEmails(owner.email)).toHaveLength(1);
  await handlers.sendConversationReplies({}, log);
  expect(limitEmails(owner.email)).toHaveLength(1);
});

test("a new project's daily cap refusing the month's last email doesn't tell the team its month is used up", async () => {
  const { owner, project } = await setup();
  // In its first week, with today's cap used up.
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date() } });
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 200 } });
  expect(await claimProjectEmail(project.id)).toBe(false);
  expect(limitEmails(owner.email)).toHaveLength(0);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 0, limit: 1 });

  // A week old: the month's one is taken, and only the next, which waits, tells the team.
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  expect(await claimProjectEmail(project.id)).toBe(true);
  expect(limitEmails(owner.email)).toHaveLength(0);
  expect(await claimProjectEmail(project.id)).toBe(false);
  expect(limitEmails(owner.email)).toHaveLength(1);
});

test("telling the team can't fail their users' email: it's best-effort", async () => {
  const { owner, project, team } = await setup();
  const emailed = await twoReplies(project, team);
  // Building the notice throws (no usable app address for its link).
  vi.stubEnv("APP_URL", "not a url");
  await expect(handlers.sendConversationReplies({}, log)).resolves.toBeDefined();
  expect(emailed()).toBe(1);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });
  expect(limitEmails(owner.email)).toHaveLength(0);
});

test("email held for a month that has reset goes whenever the safety net runs, past its look-back; nothing sent goes twice", async () => {
  const { project, team } = await setup();
  const { voters, post } = await votedPost(project);
  await call(createComment, team, { number: post.number, body: "It's out.", emailVoters: true });
  const replied = () => voters.filter((voter) => emailsTo(voter.email).some((email) => email.subject === "Re: Dark mode")).length;
  expect(replied()).toBe(1);
  // Held last month for this one, which reset two weeks ago (MID_MONTH): past the safety net's day of look-back.
  await prisma.comment.updateMany({ where: { projectId: project.id }, data: { votersEmailDueAt: month() } });
  await prisma.projectEmailMonth.deleteMany({ where: { projectId: project.id } });
  await handlers.resubmitReplyEmails({}, log);
  expect(replied()).toBe(2);
  expect(voters.map((voter) => emailsTo(voter.email).filter((email) => email.subject === "Re: Dark mode").length)).toEqual([1, 1]);
  expect((await prisma.comment.findFirstOrThrow({ where: { projectId: project.id } })).votersEmailDueAt).toBeNull();
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

test("a full project's email due now (its job never ran) is moved to next month by the safety nets, never left behind, and its team told; a paused one's isn't", async () => {
  const { owner, project, team } = await setup();
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
  // Its team hears, once, though no claim was refused.
  expect(limitEmails(owner.email)).toHaveLength(1);
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

test("a new project's shipped emails held by its daily cap are due when the cap resets, so the safety net finds them then", async () => {
  const { project, team } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date() } });
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 199 } });
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { voters, post } = await votedPost(project);
  await call(updatePost, team, { number: post.number, status: "completed" });
  const shipped = () => voters.filter((voter) => emailsTo(voter.email).some((email) => email.subject.startsWith("Done:"))).length;
  expect(shipped()).toBe(1);
  // Due a minute past tomorrow's start (UTC), not now: held from now, it would leave the day's look-back before the cap resets.
  const tomorrow = new Date(Date.UTC(MID_MONTH.getUTCFullYear(), MID_MONTH.getUTCMonth(), 16, 0, 1));
  const { id: postId, shippedEmailsDueAt } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true, shippedEmailsDueAt: true } });
  expect(shippedEmailsDueAt).toEqual(tomorrow);

  // Tomorrow, late in the day (past a look-back from when it was held): the safety net sends the rest.
  vi.setSystemTime(new Date(tomorrow.getTime() + 23 * 60 * 60_000));
  await handlers.resubmitShippedEmails({}, log);
  expect(shipped()).toBe(2);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt).toBeNull();
});

test("a paused project's held posts don't fill the shipped safety net's batch", async () => {
  const { project, team } = await setup();
  const { post } = await votedPost(project);
  await call(updatePost, team, { number: post.number, status: "completed" });
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { shippedEmailsDueAt: month() } });
  await prisma.projectEmailMonth.deleteMany({ where: { projectId: project.id } });
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date(), emailPausedReason: "2.0% of emails bounced" } });
  // Others' posts aside (the file shares a database), none of this project's is taken.
  await prisma.post.updateMany({ where: { projectId: { not: project.id } }, data: { shippedEmailsDueAt: null } });
  expect(await handlers.resubmitShippedEmails({}, log)).toEqual({ found: 0, queued: 0 });
});

test("held email whose send fails falls back to the safety nets' look-back, not retried every run for months", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 5; }));
  const { project, team } = await setup();
  const { voters, post } = await votedPost(project);
  await call(createComment, team, { number: post.number, body: "It's out.", emailVoters: true });
  // Held last month for this one; this month, one voter's address refuses it.
  await prisma.replyEmail.deleteMany({ where: { comment: { projectId: project.id }, userId: voters[1]!.id } });
  await prisma.comment.updateMany({ where: { projectId: project.id }, data: { votersEmailDueAt: month() } });
  mailbox.refuseNext(voters[1]!.email);
  await handlers.resubmitReplyEmails({}, log);
  const { votersEmailDueAt } = await prisma.comment.findFirstOrThrow({ where: { projectId: project.id } });
  expect(votersEmailDueAt!.getTime()).toBeGreaterThan(month().getTime());
  expect(votersEmailDueAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test("a shipped email whose send fails gives its slot back: the month counts what was sent", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 5; }));
  const { project } = await setup();
  const { voters } = await votedPost(project);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: new Date() } });
  mailbox.refuseNext(voters[0]!.email);
  await expect(handlers.postShipped({ postId }, log)).rejects.toThrow(/failed/);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 5 });
});

const tomorrow = () => new Date(Date.UTC(MID_MONTH.getUTCFullYear(), MID_MONTH.getUTCMonth(), 16, 0, 1));

test("a new project past its daily cap: email due now whose job never ran is moved to the cap's reset, within the look-back then", async () => {
  const { project, team } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date() } });
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 200 } });
  await votedPost(project);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  const late = new Date(Date.now() - 15 * 60_000);
  const comment = await prisma.comment.create({ data: { projectId: project.id, postId, authorId: team.actor.userId, body: "It's out.", votersEmailDueAt: late } });
  await prisma.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: late } });
  await handlers.resubmitShippedEmails({}, log);
  await handlers.resubmitReplyEmails({}, log);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt).toEqual(tomorrow());
  expect((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).votersEmailDueAt).toEqual(tomorrow());
});

test("resuming a paused project drops what the daily cap held for tomorrow, as what the pause held: it went to the same list", async () => {
  const { project, team } = await setup();
  const { post } = await votedPost(project);
  await call(updatePost, team, { number: post.number, status: "completed" });
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { shippedEmailsDueAt: tomorrow() } });
  const pausedAt = new Date(Date.now() - 60_000);
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: pausedAt, emailPausedReason: "2.0% of emails bounced" } });
  expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
  expect((await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).shippedEmailsDueAt).toBeNull();
});

test("a full month's sample post isn't moved, and tells nobody", async () => {
  const { owner, project } = await setup();
  await votedPost(project);
  await prisma.projectEmailMonth.create({ data: { projectId: project.id, month: month(), emails: 1 } });
  const late = new Date(Date.now() - 15 * 60_000);
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "COMPLETED", sample: true, shippedEmailsDueAt: late } });
  await handlers.resubmitShippedEmails({}, log);
  expect((await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).shippedEmailsDueAt).toEqual(late);
  expect(limitEmails(owner.email)).toHaveLength(0);
});

test("on a month's last day, a resume still drops what the daily cap held: its hold is never the monthly limit's marker", async () => {
  const lastDay = new Date(Date.UTC(MID_MONTH.getUTCFullYear(), MID_MONTH.getUTCMonth() + 1, 0, 12));
  vi.setSystemTime(lastDay);
  const { project } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date() } });
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: new Date(new Date().toISOString().slice(0, 10)), claimed: 200 } });
  await votedPost(project);
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { status: "COMPLETED", shippedEmailsDueAt: new Date(Date.now() - 15 * 60_000) } });
  await handlers.resubmitShippedEmails({}, log);
  const due = async () => (await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).shippedEmailsDueAt;
  // A minute past next month's first instant: the daily cap's, not the monthly limit's.
  expect(await due()).toEqual(new Date(nextMonth().getTime() + 60_000));
  const pausedAt = new Date(Date.now() - 60_000);
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: pausedAt, emailPausedReason: "2.0% of emails bounced" } });
  expect(await resumeEmailSending(resumeToken(project.id, pausedAt))).toEqual({});
  expect(await due()).toBeNull();
});

test("held for a month that has reset, a shipped email whose send fails is due from now, not retried every run for months", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 5; }));
  const { project } = await setup();
  const { voters } = await votedPost(project);
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: month() } });
  mailbox.refuseNext(voters[0]!.email);
  await expect(handlers.postShipped({ postId }, log)).rejects.toThrow(/failed/);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt!.getTime()).toBe(Date.now());
});

test("on a free trial, email is held at the trial's own allowance, not its plan's; once it ends, at the default plan's", async () => {
  // The trial gives Pro (10,000 a month) with 1 email; Free, the default plan, sends 3.
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { free }) => {
    free.limits.emailsPerMonth = 3;
    config.trial = { plan: "pro", days: 7, emails: 1 };
  }));
  const { owner, project, team } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000) } });
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });
  // The team hears of the trial's allowance, and the plan with more room than it.
  const [told] = limitEmails(owner.email);
  expect(told?.text).toContain("has sent the 1 email its Pro plan includes");
  expect(told?.text).toContain("Upgrade to Pro for more.");

  // The trial over: Free's 3, so the waiting one goes.
  await prisma.project.update({ where: { id: project.id }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 3 });
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
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
