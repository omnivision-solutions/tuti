import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { emailsThisMonth, handlers } from "@tuti/jobs";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { emailSignInLink } from "./sign-in-link";

/**
 * A plan's monthly email limit (emailsPerMonth; packages/jobs/src/email-limits.ts): a project's email to its users is
 * counted each calendar month (UTC); past its plan's limit it waits for the next month, and its owners and admins are
 * told once.
 */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  // Free sends 1 email a month.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.emailsPerMonth = 1; }));
});
afterEach(() => vi.unstubAllEnvs());

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
  vi.useFakeTimers({ toFake: ["Date"], now: nextMonth() });
  onTestFinished(() => void vi.useRealTimers());
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
  expect(await emailsThisMonth(project.id)).toEqual({ emails: 1, limit: 1 });
});

test("shipped emails past the limit are due again next month, and go then", async () => {
  const { project, team } = await setup();
  const voters = [await signUp("Val Voter"), await signUp("Vic Voter")];
  await prisma.user.updateMany({ where: { id: { in: voters.map((v) => v.id) } }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voters[0]!.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await call(setVote, { actor: { kind: "user", userId: voters[1]!.id }, projectId: project.id }, { number: post.number, voted: true });
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
