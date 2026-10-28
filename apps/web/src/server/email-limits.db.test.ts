import { prisma } from "@tuti/db";
import { claimProjectEmail, handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import { POST } from "@/app/api/email/events/route";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { resumeEmailSending } from "./email-pause";
import { emailSignInLink } from "./sign-in-link";

/**
 * Watching projects' email on a server selling plans (packages/jobs/src/email-limits.ts): in a
 * project's first week its replies and "shipped" emails stop at 200 a day, taken as they're sent,
 * the rest waiting for tomorrow; and a project whose bounces or complaints go over is paused until
 * the operator resumes it.
 */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };

const OPERATOR = "e2e-operator@example.com";
const ses = await startSesFake();
afterAll(() => ses.close());
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("APP_PORTAL_OWNER", OPERATOR);
});
afterEach(() => vi.unstubAllEnvs());

const today = () => new Date(new Date().toISOString().slice(0, 10));
const emailsTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  // 199 taken today: room for one more.
  await prisma.projectEmailDay.create({ data: { projectId: project.id, day: today(), claimed: 199 } });
  const aWeekOld = () => prisma.project.update({ where: { id: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  return { owner, project, team, aWeekOld };
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
  // Not due for the tests after (the database is the file's).
  await prisma.conversation.deleteMany({ where: { projectId: project.id } });
});

let events = 0;
/** SES's event for one of the project's emails, as SNS posts it. */
function snsEvent(projectId: string, eventType: "Send" | "Bounce" | "Complaint") {
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, value);
  }
  const message = JSON.stringify({
    eventType,
    mail: { messageId: `0100-event-${++events}`, timestamp: new Date().toISOString(), tags: { project: [projectId] } },
    ...(eventType === "Bounce" && { bounce: { bounceType: "Permanent" } }),
    ...(eventType === "Complaint" && { complaint: {} }),
  });
  return ses.sns("Notification", message);
}
const postEvent = async (event: Record<string, string>) =>
  (await POST(new Request("http://localhost/api/email/events", { method: "POST", body: JSON.stringify(event) }))).status;
async function sesEvent(projectId: string, eventType: "Send" | "Bounce" | "Complaint") {
  expect(await postEvent(snsEvent(projectId, eventType))).toBe(200);
}
const pausedAt = async (projectId: string) => (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { emailPausedAt: true } })).emailPausedAt;
const linkIn = (text: string) => new URL(text.split(/\s+/).find((word) => word.includes("/resume-email?"))!.replace(/[[\]]/g, "")).searchParams.get("token")!;

test("too many bounces pause the project's email: replies and shipped wait, sign-in links go, the operator and team are told; the operator's link resumes it", async () => {
  const { owner, project, team, aWeekOld } = await setup();
  // Past its first week, so its cap isn't what holds replies here.
  await aWeekOld();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 100, bounced: 1 } });
  await sesEvent(project.id, "Bounce");
  const paused = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { emailPausedAt: true, emailPausedReason: true } });
  expect(paused).toEqual({ emailPausedAt: expect.any(Date), emailPausedReason: "2.0% of emails bounced in the last 2 weeks (2 of 100)" });

  const [toOperator] = emailsTo(OPERATOR);
  expect(toOperator).toMatchObject({ subject: `${project.name}'s email is paused` });
  expect(toOperator!.text).toContain("2.0% of emails bounced in the last 2 weeks (2 of 100)");
  const [toTeam] = emailsTo(owner.email).filter((email) => email.subject.endsWith("is paused"));
  expect(toTeam).toMatchObject({ subject: `${project.name}'s email is paused` });
  expect(toTeam!.replyTo).toContain(OPERATOR);
  // Once: another bounce while it's paused tells nobody again.
  await sesEvent(project.id, "Bounce");
  expect(emailsTo(OPERATOR)).toHaveLength(1);

  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(0);
  actAs(null);
  const reader = `e2e-signin-${project.slug}@example.com`;
  const form = new FormData();
  form.set("email", reader);
  await emailSignInLink(project.slug, "/", form);
  expect(emailsTo(reader)).toHaveLength(1);

  // The operator's link resumes it, and the replies go.
  const token = linkIn(toOperator!.text);
  expect(await resumeEmailSending("not-a-token")).toEqual({ error: "This link doesn't work any more" });
  expect(await resumeEmailSending(token)).toEqual({});
  expect(await pausedAt(project.id)).toBeNull();
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);

  // Its rates count from the day after: late bounces for the emails before don't pause it again.
  await sesEvent(project.id, "Bounce");
  await sesEvent(project.id, "Complaint");
  expect(await pausedAt(project.id)).toBeNull();
  // And the link was for that pause: it can't undo a later one.
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date(), emailPausedReason: "5 people marked emails as spam in the last 2 weeks" } });
  expect(await resumeEmailSending(token)).toEqual({ error: "This pause is over" });
  expect(await pausedAt(project.id)).not.toBeNull();
});

test("sends that come after the bounces still pause it, once there are 100", async () => {
  const { project } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 98, bounced: 2 } });
  await sesEvent(project.id, "Send");
  expect(await pausedAt(project.id)).toBeNull();
  await sesEvent(project.id, "Send");
  expect(await pausedAt(project.id)).not.toBeNull();
});

test("if telling the operator fails, SNS's next try tells them; a check that didn't run runs then too", async () => {
  const { project } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 100, bounced: 1 } });
  const told = () => emailsTo(OPERATOR).filter((email) => email.subject === `${project.name}'s email is paused`);
  mailbox.refuseNext(OPERATOR);
  const bounce = snsEvent(project.id, "Bounce");
  await expect(postEvent(bounce)).rejects.toThrow();
  expect(await pausedAt(project.id)).not.toBeNull();
  expect(told()).toEqual([]);
  // SNS tries the same message again: it's counted once, and the operator is told.
  expect(await postEvent(bounce)).toBe(200);
  expect(told()).toHaveLength(1);
  expect((await prisma.projectEmailDay.findFirstOrThrow({ where: { projectId: project.id } })).bounced).toBe(2);
});

test("a project paused mid-run stops there; without an operator to resume it, nothing is paused", async () => {
  const { project } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
  expect(await claimProjectEmail(project.id)).toBe(false);

  const other = await setup();
  vi.stubEnv("APP_PORTAL_OWNER", "");
  await prisma.projectEmailDay.updateMany({ where: { projectId: other.project.id }, data: { sent: 100, bounced: 1 } });
  await sesEvent(other.project.id, "Bounce");
  expect(await pausedAt(other.project.id)).toBeNull();
});

test("not paused under the limits: bounces before 100 sent, or a few complaints in a lot of email; 5 complaints pause it", async () => {
  const { project } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 99, bounced: 9 } });
  await sesEvent(project.id, "Bounce");
  expect(await pausedAt(project.id)).toBeNull();

  // 3 complaints in 20,000 is under 0.03%.
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 20_000, bounced: 0, complained: 2 } });
  await sesEvent(project.id, "Complaint");
  expect(await pausedAt(project.id)).toBeNull();
  await sesEvent(project.id, "Complaint");
  await sesEvent(project.id, "Complaint");
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { emailPausedReason: true } })).toEqual({
    emailPausedReason: "5 people marked emails as spam in the last 2 weeks",
  });
});

test("on a server that doesn't sell plans, nothing is counted or paused, and a pause from before holds nothing", async () => {
  vi.stubEnv("PLANS", "");
  const { project, team } = await setup();
  await prisma.projectEmailDay.updateMany({ where: { projectId: project.id }, data: { sent: 100, bounced: 50 } });
  await sesEvent(project.id, "Bounce");
  expect(await pausedAt(project.id)).toBeNull();

  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
  const emailed = await twoReplies(project, team);
  await handlers.sendConversationReplies({}, log);
  expect(emailed()).toBe(2);
});
