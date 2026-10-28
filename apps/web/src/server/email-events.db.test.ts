import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import { POST } from "@/app/api/email/events/route";
import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";

/** Amazon SES's events, through SNS to /api/email/events (docs/plan.md, Support inbox, item 11). */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };
const ses = await startSesFake();
afterAll(() => ses.close());
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

const post = async (body: unknown) => (await POST(new Request("http://localhost/api/email/events", { method: "POST", body: JSON.stringify(body) }))).status;
const event = (eventType: string, sesId: string, extra: object = {}, sentAt = new Date()) =>
  JSON.stringify({ eventType, mail: { messageId: sesId, timestamp: sentAt.toISOString() }, ...extra });
const bounce = { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } };

/** A conversation by email with one reply emailed, which SES gave `sesId`. */
async function emailed(sesId: string) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const address = supportAddress(await mailSubdomain(project.id), DOMAIN);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const kim = `e2e-kim-${project.slug}@example.com`;
  await postEmail(rawEmail({ from: kim, to: address, subject: "Invoice missing" }), { recipient: address });
  await call(replyToConversation, team, { number: 1, body: "It's under Billing." });
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } });
  // As the sending job leaves it when SES's SMTP answers "250 Ok <id>".
  await prisma.conversationMessage.update({ where: { id: message.id }, data: { emailStatus: "SENT", deliveredMessageId: `<${sesId}@email.amazonses.com>` } });
  const status = async () => prisma.conversationMessage.findUniqueOrThrow({ where: { id: message.id }, select: { emailStatus: true, emailError: true } });
  return { project, team, kim, status };
}

const id = (n: number) => `010001929d1c7b0f-1b2c3d4e-5f60-7182-93a4-b5c6d7e8f9${String(n).padStart(2, "0")}-000000`;

test("a signed bounce marks the email bounced, with why; unsigned or from another topic, it's refused", async () => {
  const { status } = await emailed(id(1));
  expect(await post(ses.sns("Notification", event("Bounce", id(1), bounce), { signed: false }))).toBe(401);
  expect(await post(ses.sns("Notification", event("Bounce", id(1), bounce), { topicArn: "arn:aws:sns:us-east-1:000000000000:someone-elses" }))).toBe(403);
  expect(await status()).toEqual({ emailStatus: "SENT", emailError: null });

  expect(await post(ses.sns("Notification", event("Bounce", id(1), bounce)))).toBe(200);
  expect(await status()).toEqual({ emailStatus: "BOUNCED", emailError: "The address doesn't take email (smtp; 550 5.1.1 user unknown)" });
});

test("delivered, then forward only: the same event twice, or a delivery after a bounce, leaves it bounced", async () => {
  const { status } = await emailed(id(2));
  expect(await post(ses.sns("Notification", event("Delivery", id(2))))).toBe(200);
  expect((await status()).emailStatus).toBe("DELIVERED");

  const bounced = ses.sns("Notification", event("Bounce", id(2), bounce));
  expect(await post(bounced)).toBe(200);
  expect(await post(bounced)).toBe(200);
  expect(await post(ses.sns("Notification", event("Delivery", id(2))))).toBe(200);
  expect((await status()).emailStatus).toBe("BOUNCED");
  expect(await prisma.emailEvent.count({ where: { id: bounced.MessageId } })).toBe(1);
});

test("a complaint marks the email complained and stops emails to that address from the project", async () => {
  const { project, team, kim, status } = await emailed(id(3));
  const complaint = { complaint: { complainedRecipients: [{ emailAddress: kim.toUpperCase() }] } };
  expect(await post(ses.sns("Notification", event("Complaint", id(3), complaint)))).toBe(200);
  expect((await status()).emailStatus).toBe("COMPLAINED");
  expect(await prisma.emailBlock.findMany({ where: { projectId: project.id }, select: { email: true } })).toEqual([{ email: kim }]);

  // The next reply isn't emailed: it says why.
  await call(replyToConversation, team, { number: 1, body: "Anything else?" });
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
  await handlers.sendConversationReplies({}, log);
  expect(mailbox.emails.filter((email) => email.to.includes(kim))).toEqual([]);
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, body: "Anything else?" } })).toMatchObject({
    emailStatus: "FAILED",
    emailError: expect.stringContaining("marked an email from you as spam"),
  });
});

test("the subscription is confirmed for this server's topic only; without SES, there's nothing here", async () => {
  expect(await post(ses.sns("SubscriptionConfirmation", "Confirm", { topicArn: "arn:aws:sns:us-east-1:000000000000:someone-elses" }))).toBe(403);
  expect(ses.confirmations).toBe(0);
  expect(await post(ses.sns("SubscriptionConfirmation", "Confirm"))).toBe(200);
  expect(ses.confirmations).toBe(1);

  vi.stubEnv("SES_REGION", "");
  expect(await post(ses.sns("Notification", event("Delivery", id(4))))).toBe(404);
});

test("an email with several replies: all of them are marked, not the previous email's", async () => {
  const { project, team, status } = await emailed(id(5));
  // The previous email (its last message carries our Message-ID), then two replies in one email.
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, author: "TEAM" }, data: { sentMessageId: `<earlier-${project.slug}@tuti.email>`, deliveredMessageId: null } });
  await call(replyToConversation, team, { number: 1, body: "One more thing" });
  await call(replyToConversation, team, { number: 1, body: "And another" });
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, body: { in: ["One more thing", "And another"] } }, data: { emailStatus: "SENT" } });
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, body: "And another" }, data: { deliveredMessageId: `<${id(6)}@email.amazonses.com>` } });

  expect(await post(ses.sns("Notification", event("Bounce", id(6), bounce)))).toBe(200);
  const statuses = await prisma.conversationMessage.findMany({ where: { projectId: project.id, author: "TEAM" }, orderBy: { createdAt: "asc" }, select: { emailStatus: true } });
  expect(statuses.map((m) => m.emailStatus)).toEqual(["SENT", "BOUNCED", "BOUNCED"]);
  expect((await status()).emailStatus).toBe("SENT");
});

test("an event that comes before the send saved SES's id is tried again by SNS; an old one for no email is dropped", async () => {
  const { project, status } = await emailed(id(7));
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, author: "TEAM" }, data: { deliveredMessageId: null } });
  const early = ses.sns("Notification", event("Delivery", id(7)));
  expect(await post(early)).toBe(503);
  // The send saves it: SNS's next try counts.
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, author: "TEAM" }, data: { deliveredMessageId: `<${id(7)}@email.amazonses.com>` } });
  expect(await post(early)).toBe(200);
  expect((await status()).emailStatus).toBe("DELIVERED");

  expect(await post(ses.sns("Notification", event("Delivery", id(8), {}, new Date(Date.now() - 60 * 60_000))))).toBe(200);
});
