import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { notifyInboxNow, subscribeInbox } from "./live";
import { replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";

/** Replies by email (packages/jobs send-conversation-replies): the team's replies the user hasn't seen a minute on. */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };
const run = () => handlers.sendConversationReplies({}, log);

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const subdomain = await mailSubdomain(project.id);
  const address = supportAddress(subdomain, DOMAIN);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const kim = `e2e-kim-${project.slug}@example.com`;
  await postEmail(rawEmail({ from: `Kim Lee <${kim}>`, to: address, subject: "Invoice missing", messageId: `<first-${project.slug}@example.com>` }), {
    recipient: address,
  });
  return { project, subdomain, address, team, kim };
}

/** Moves the conversation's messages back in time, so the minute has passed. */
const aMinuteOn = (projectId: string) =>
  prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${projectId}`;
const emailsTo = (address: string) => mailbox.emails.filter((email) => email.to.includes(address));

test("a reply they haven't seen a minute on is emailed from the project's address, Reply-To the conversation's, threaded", async () => {
  const { project, subdomain, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "It's under Billing → Invoices." });
  // Not yet a minute.
  await run();
  expect(emailsTo(kim)).toEqual([]);

  await aMinuteOn(project.id);
  await run();
  const [email] = emailsTo(kim);
  expect(email).toMatchObject({
    from: `"Olive Owner at ${project.name}" <support@${subdomain}.${DOMAIN}>`,
    subject: "Re: Invoice missing",
  });
  const { replyToken } = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(email!.replyTo).toContain(`support+${replyToken}@${subdomain}.${DOMAIN}`);
  expect(email!.text).toContain("It's under Billing → Invoices.");
  expect(email!.headers["in-reply-to"]).toBe(`<first-${project.slug}@example.com>`);
  expect(email!.headers["x-tuti-loop"]).toBe(subdomain);
  const sent = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } });
  expect(sent).toMatchObject({ emailStatus: "SENT", emailClaimedAt: null, sentMessageId: email!.headers["message-id"] });

  // Sent once.
  await run();
  expect(emailsTo(kim)).toHaveLength(1);
});

test("their reply naming our Message-ID joins the conversation, even to the plain address", async () => {
  const { project, address, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Found it?" });
  await aMinuteOn(project.id);
  await run();
  const sentId = emailsTo(kim)[0]!.headers["message-id"]!;
  await postEmail(rawEmail({ from: kim, to: address, subject: "Re: Invoice missing", body: "Yes, thanks!", headers: { "In-Reply-To": sentId } }), {
    recipient: address,
  });
  const conversations = await prisma.conversation.findMany({ where: { projectId: project.id }, include: { messages: true } });
  expect(conversations).toHaveLength(1);
  expect(conversations[0]!.messages.map((m) => m.body)).toContain("Yes, thanks!");
});

test("sent through Amazon SES, under its own Message-ID: replies naming that one join too, and later emails reference it", async () => {
  const { project, address, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Found it?" });
  await aMinuteOn(project.id);
  const ses = "0100019a2b3c4d5e-1a2b3c4d-5e6f-4a1b-9c8d-0123456789ab-000000";
  mailbox.answerNext(kim, `Ok ${ses}`);
  await run();
  const delivered = `<${ses}@email.amazonses.com>`;
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } })).toMatchObject({
    deliveredMessageId: delivered,
  });

  await postEmail(rawEmail({ from: kim, to: address, subject: "Re: Invoice missing", body: "Yes, thanks!", headers: { "In-Reply-To": delivered } }), {
    recipient: address,
  });
  const conversations = await prisma.conversation.findMany({ where: { projectId: project.id }, include: { messages: true } });
  expect(conversations).toHaveLength(1);
  expect(conversations[0]!.messages.map((m) => m.body)).toContain("Yes, thanks!");

  await call(replyToConversation, team, { number: 1, body: "Great" });
  await aMinuteOn(project.id);
  await run();
  expect(emailsTo(kim)[1]!.headers.references).toContain(delivered);
});

test("the team's pages hear when a reply is emailed, or fails for good", async () => {
  const { project, team } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Hello?" });
  await aMinuteOn(project.id);
  const stops: (() => void)[] = [];
  const heardOf = (wants: (conversationId: string) => boolean) => {
    const heard: number[] = [];
    stops.push(subscribeInbox((change) => change.projectId === project.id && wants(change.conversationId), () => heard.push(1)));
    return heard;
  };
  const marker = (conversationId: string) => notifyInboxNow({ projectId: project.id, conversationId, userId: null, visitorHash: null });
  const connected = heardOf((id) => id === "connected");
  const last = heardOf((id) => id === "last");
  const heard = heardOf((id) => id !== "connected" && id !== "last");
  try {
    // Listening once a marker's heard; and NOTIFYs arrive in order, so once the last one's heard, so is the job's.
    await vi.waitFor(async () => {
      await marker("connected");
      expect(connected.length).toBeGreaterThan(0);
    });
    await run();
    await marker("last");
    await vi.waitFor(() => expect(last).toHaveLength(1));
    expect(heard).toHaveLength(1);
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("seen in the widget, a note, spam, or two runs at once: no email, or just one", async () => {
  const { project, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "One" });
  await call(replyToConversation, team, { number: 1, body: "Two" });
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, body: "One" }, data: { seenAt: new Date() } });
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, body: "Two" }, data: { note: true } });
  await aMinuteOn(project.id);
  await run();
  expect(emailsTo(kim)).toEqual([]);

  await call(replyToConversation, team, { number: 1, body: "Three" });
  await call(replyToConversation, team, { number: 1, body: "Four" });
  await aMinuteOn(project.id);
  await Promise.all([run(), run(), run()]);
  // Both unseen replies, in one email.
  expect(emailsTo(kim)).toHaveLength(1);
  expect(emailsTo(kim)[0]!.text).toMatch(/Three[\s\S]*Four/);

  await call(updateConversation, team, { number: 1, spam: true });
  await call(replyToConversation, team, { number: 1, body: "Five" });
  await aMinuteOn(project.id);
  await run();
  expect(emailsTo(kim)).toHaveLength(1);
});

test("a send that fails is tried again by the next runs, three times, then shown as failed", async () => {
  const { project, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Hello?" });
  await aMinuteOn(project.id);
  const message = () => prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } });
  mailbox.refuseNext(kim);
  await run();
  expect(await message()).toMatchObject({ emailStatus: null, emailAttempts: 1, emailClaimedAt: null, emailError: expect.stringContaining("refused") });
  await run();
  expect(await message()).toMatchObject({ emailStatus: "SENT", emailAttempts: 1 });

  await call(replyToConversation, team, { number: 1, body: "Still there?" });
  await aMinuteOn(project.id);
  for (let i = 0; i < 3; i++) {
    mailbox.refuseNext(kim);
    await run();
  }
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, body: "Still there?" } })).toMatchObject({
    emailStatus: "FAILED",
    emailAttempts: 3,
  });
  await run();
  expect(emailsTo(kim)).toHaveLength(1);
});
