import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { type InboxChange, listening, notifyInboxNow, subscribeInbox } from "./live";
import { replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { widgetConversation, widgetStartConversation } from "./widget-inbox";

/** Replies by email (packages/jobs send-conversation-replies): the team's replies the user hasn't seen a minute on. */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };
const run = () => handlers.sendConversationReplies({}, log);

const ses = await startSesFake();
afterAll(() => ses.close());
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});
afterEach(() => vi.unstubAllEnvs());

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
  // In the project's accent colour.
  await prisma.project.update({ where: { id: project.id }, data: { brandColor: "#7c3aed" } });
  await call(replyToConversation, team, { number: 1, body: "It's under Billing → Invoices." });
  // Not yet a minute.
  await run();
  expect(emailsTo(kim)).toEqual([]);

  await aMinuteOn(project.id);
  await run();
  const [email] = emailsTo(kim);
  expect(email!.html).toContain("border-top:4px solid #7c3aed");
  expect(email).toMatchObject({
    from: `"Olive Owner at ${project.name}" <support@${subdomain}.${DOMAIN}>`,
    subject: "Re: Invoice missing",
  });
  const { replyToken } = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(email!.replyTo).toContain(`support+${replyToken}@${subdomain}.${DOMAIN}`);
  expect(email!.text).toContain("It's under Billing → Invoices.");
  expect(email!.headers["in-reply-to"]).toBe(`<first-${project.slug}@example.com>`);
  expect(email!.headers["x-tuti-loop"]).toBe(subdomain);
  // No SES on this server: no tenant.
  expect(email!.headers["x-ses-tenant"]).toBeUndefined();
  const sent = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } });
  expect(sent).toMatchObject({ emailStatus: "SENT", emailClaimedAt: null, sentMessageId: email!.headers["message-id"] });

  // Sent once.
  await run();
  expect(emailsTo(kim)).toHaveLength(1);
});

test("one project's backlog doesn't hold up another's replies: each project gets a turn in every run", async () => {
  // A has more waiting replies than one run sends (100), all older than B's one.
  const a = await setup();
  await call(replyToConversation, a.team, { number: 1, body: "Looking into it." });
  const { id: _id, replyToken: _token, number: _number, ...conversation } = await prisma.conversation.findFirstOrThrow({ where: { projectId: a.project.id } });
  await prisma.conversation.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ ...conversation, number: i + 2 })) });
  const backlog = await prisma.conversation.findMany({ where: { projectId: a.project.id, number: { gt: 1 } }, select: { id: true } });
  await prisma.conversationMessage.createMany({
    data: backlog.map(({ id }) => ({ projectId: a.project.id, conversationId: id, author: "TEAM" as const, channel: "APP" as const, body: "Looking into it." })),
  });
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '10 minutes' WHERE "projectId" = ${a.project.id}`;

  const b = await setup();
  await call(replyToConversation, b.team, { number: 1, body: "Fixed now." });
  await aMinuteOn(b.project.id);

  await run();
  expect(emailsTo(b.kim)).toHaveLength(1);
  expect(emailsTo(a.kim)).toHaveLength(99);
  // A's two newest wait for the next run.
  expect(await prisma.conversationMessage.count({ where: { projectId: a.project.id, author: "TEAM", emailStatus: null } })).toBe(2);
  await run();
  expect(emailsTo(a.kim)).toHaveLength(101);
}, 60_000);

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
  const { project, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Hello?" });
  await aMinuteOn(project.id);
  const stops: (() => void)[] = [];
  const heardOf = (wants: (change: InboxChange) => boolean) => {
    const heard: number[] = [];
    stops.push(subscribeInbox((change) => change.projectId === project.id && wants(change), () => heard.push(1)));
    return heard;
  };
  const marker = (conversationId: string) => notifyInboxNow({ projectId: project.id, conversationId, userId: null, visitorHash: null });
  // Once the listener is listening, so they hear only real changes; NOTIFYs arrive in order, so once the last one's heard, so is the job's.
  await listening();
  const last = heardOf(({ conversationId }) => conversationId === "last");
  // With its address: the widget of whoever's signed in with it hears too (widget-person.ts, hears).
  const heard = heardOf(({ conversationId, email }) => conversationId !== "last" && email === kim);
  try {
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

test("with Amazon SES, sent under the project's own tenant, set up once before its first email", async () => {
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, value);
  }
  const { project, team, kim } = await setup();
  await call(replyToConversation, team, { number: 1, body: "Hello?" });
  await aMinuteOn(project.id);
  // SES failed halfway through the setup: nothing sent, and the next run finishes it.
  ses.failing.add("/v2/email/tenants/resources");
  await run();
  expect(emailsTo(kim)).toEqual([]);
  ses.failing.clear();
  // One association failing while the other is still on its way: the run waits for it rather than leaving
  // it calling SES after the run (the failing call's retries are over in under half a second).
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  ses.respond = async (path, body) => {
    if (path === "/v2/email/tenants/resources") {
      if (String(body.ResourceArn).includes(":configuration-set/")) {
        await held;
      } else {
        return 500;
      }
    }
  };
  const running = run();
  try {
    const early = await Promise.race([running.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 1000))]);
    expect(early).toBe("waiting");
  } finally {
    // Answered whatever happened above, so a failure doesn't leave the call open until its deadline.
    release();
    await running;
    ses.respond = undefined;
  }
  expect(emailsTo(kim)).toEqual([]);
  await run();

  const tenant = `tuti-test-${project.id}`;
  const [email] = emailsTo(kim);
  expect(email!.headers["x-ses-tenant"]).toBe(tenant);
  expect(email!.headers["x-ses-configuration-set"]).toBe("tuti-test");
  // Its events name the project and that it's a reply (apps/web/src/server/email-events.ts).
  expect(email!.headers["x-ses-message-tags"]).toBe(`project=${project.id}, email=reply`);
  // Its own suppression list, and what its mail uses associated with it (SES refuses the mail otherwise).
  expect(ses.tenants.get(tenant)).toEqual({
    suppression: { SuppressedReasons: ["BOUNCE", "COMPLAINT"], SuppressionScope: "TENANT" },
    resources: new Set([`arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`, "arn:aws:ses:us-east-1:000000000000:configuration-set/tuti-test"]),
  });

  // Set up once: the next email doesn't ask SES again.
  const calls = ses.calls.length;
  await call(replyToConversation, team, { number: 1, body: "Still there?" });
  await aMinuteOn(project.id);
  await run();
  expect(emailsTo(kim)).toHaveLength(2);
  expect(emailsTo(kim)[1]!.headers["x-ses-tenant"]).toBe(tenant);
  expect(ses.calls).toHaveLength(calls);

  // Another support domain: its identity is associated too, before the next email.
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "help.example.com");
  await call(replyToConversation, team, { number: 1, body: "Anything else?" });
  await aMinuteOn(project.id);
  await run();
  expect(ses.tenants.get(tenant)!.resources).toContain("arn:aws:ses:us-east-1:000000000000:identity/help.example.com");
  expect(emailsTo(kim)).toHaveLength(3);

  // Another SES account (or region), same configuration set: the tenant is made there too.
  ses.tenants.clear();
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", "arn:aws:sns:us-east-1:111111111111:tuti-test-events");
  await call(replyToConversation, team, { number: 1, body: "Last one." });
  await aMinuteOn(project.id);
  await run();
  expect(ses.tenants.get(tenant)!.resources).toContain("arn:aws:ses:us-east-1:111111111111:configuration-set/tuti-test");
  expect(emailsTo(kim)).toHaveLength(4);
});

test("the widget says a reply will be emailed exactly when this job emails it (both read replyRecipient)", async () => {
  const cases: [string, (project: { id: string }, email: string) => Promise<unknown>][] = [
    ["emailed", async () => {}],
    ["the project has no support address", (project) => prisma.mailSubdomain.deleteMany({ where: { projectId: project.id } })],
    ["they marked its email as spam", (project, email) => prisma.emailBlock.create({ data: { projectId: project.id, email } })],
    ["the conversation is spam", (project) => prisma.conversation.updateMany({ where: { projectId: project.id }, data: { spam: true } })],
    ["the server sends no email", async () => vi.stubEnv("SMTP_HOST", "")],
  ];
  const smtp = process.env.SMTP_HOST!;
  const results = [];
  for (const [name, change] of cases) {
    vi.stubEnv("SMTP_HOST", smtp);
    const owner = await signUp("Olive Owner");
    const project = await createProject(owner);
    await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
    await mailSubdomain(project.id);
    const email = `e2e-visitor-${project.slug}@example.com`;
    const started = await widgetStartConversation(project.slug, {}, "Is there a nonprofit discount?", email);
    const visitor = { visitor: "visitor" in started ? started.visitor : null };
    await call(replyToConversation, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { number: 1, body: "Yes: half off." });
    await change(project, email);
    // Read as a hidden panel does: shown, the reply would be seen, and then rightly not emailed.
    const promised = await widgetConversation(project.slug, visitor, 1, false);
    await aMinuteOn(project.id);
    await run();
    results.push([name, "emailedTo" in promised && promised.emailedTo === email, emailsTo(email).length > 0]);
  }
  expect(results).toEqual(cases.map(([name], i) => [name, i === 0, i === 0]));
});
