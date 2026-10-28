import { prisma } from "@tuti/db";
import { claimProjectEmail, handlers } from "@tuti/jobs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";

/**
 * A new project's daily cap (packages/jobs/src/email-limits.ts): in its first week on a server
 * selling plans, its replies and "shipped" emails stop at 200 a day, taken as they're sent; the rest
 * wait for tomorrow.
 */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  vi.stubEnv("PLANS", "on");
});
afterEach(() => vi.unstubAllEnvs());

const today = () => new Date(new Date().toISOString().slice(0, 10));
const emailsTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { emailApprovedAt: new Date() } });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  // 199 taken today: room for one more.
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: today(), claimed: 199 } });
  const aWeekOld = () => prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  return { project, team, aWeekOld };
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

test("in a new project's first week, replies past its daily cap wait; once it's a week old they go", async () => {
  const { project, team, aWeekOld } = await setup();
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM", emailStatus: null } })).toBe(1);

  await aWeekOld();
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
});

test("on a server that doesn't sell plans, there's no cap", async () => {
  vi.stubEnv("PLANS", "");
  const { project, team } = await setup();
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
});

test("shipped emails past the cap stay due, and go once they may", async () => {
  const { project, team, aWeekOld } = await setup();
  const voters = [await signUp("Val Voter"), await signUp("Vic Voter")];
  await prisma.user.updateMany({ where: { id: { in: voters.map((v) => v.id) } }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voters[0]!.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await call(setVote, { actor: { kind: "user", userId: voters[1]!.id }, projectId: project.id }, { number: post.number, voted: true });
  await call(updatePost, team, { number: post.number, status: "completed" });
  const shipped = () => voters.filter((voter) => emailsTo(voter.email).some((email) => email.subject.startsWith("Done:"))).length;
  expect(shipped()).toBe(1);
  const { id: postId, shippedEmailsDueAt } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true, shippedEmailsDueAt: true } });
  // Due from now: the cron, which looks back a day, keeps bringing it back till the cap lets the rest go.
  expect(shippedEmailsDueAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

  await aWeekOld();
  await handlers.postShipped({ postId }, log);
  expect(shipped()).toBe(2);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).shippedEmailsDueAt).toBeNull();
});

test("sends at once can't pass the cap together", async () => {
  const { project } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { claimed: 198 } });
  const claims = await Promise.all(Array.from({ length: 5 }, () => claimProjectEmail(project.id)));
  expect(claims.filter(Boolean)).toHaveLength(2);
});

test("a capped project's replies aren't picked, so they can't hold up other projects'", async () => {
  const { project } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { claimed: 200 } });
  // A whole run's worth of its replies, older than anyone else's.
  for (let number = 1; number <= 100; number++) {
    await prisma.conversation.create({
      data: {
        projectId: project.id,
        number,
        subject: "Hi",
        origin: "EMAIL",
        email: `e2e-${number}-${project.slug}@example.com`,
        messages: { create: { projectId: project.id, author: "TEAM", channel: "APP", body: "Hello", createdAt: new Date(Date.now() - 10 * 60_000) } },
      },
    });
  }
  const other = await setup();
  const emailed = await twoReplies(other.project, other.team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(1);
});
