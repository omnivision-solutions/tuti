import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";

import { SIGN_IN_LINKS_PER_PORTAL_PER_HOUR } from "@/lib/sign-in-link";
import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation, startConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { notifyInboxNow, subscribeInbox } from "./live";
import { widgetConversation, widgetConversations, widgetHere, widgetSendMessage, widgetStartConversation } from "./widget-inbox";
import { hears, widgetPerson } from "./widget-person";

async function setup(inbox = true) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: inbox } });
  const userId = await upsertProjectUser(project.id, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  actAs(null);
  return { owner, project, team, userId, auth: { token: widgetToken(project.id, userId) } };
}

afterEach(() => vi.unstubAllEnvs());

const signInFirst = { error: "Sign in to message the team" };

test("someone the page signs in writes to the team, sees replies, and seeing them clears the count", async () => {
  const { project, team, auth } = await setup();
  expect(await widgetConversations(project.slug, auth)).toEqual({ conversations: [], unseen: 0 });

  const started = await widgetStartConversation(project.slug, auth, "Where's my invoice?");
  expect(started).toEqual({ number: 1 });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ origin: "WIDGET", status: "OPEN" });

  await call(replyToConversation, team, { number: 1, body: "In Billing → Invoices." });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: 1, subject: "Where's my invoice?", unseen: 1 }], unseen: 1 });

  // A hidden panel reads it without seeing it.
  await widgetConversation(project.slug, auth, 1, false);
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ unseen: 1 });
  const opened = await widgetConversation(project.slug, auth, 1);
  expect(opened).toMatchObject({
    messages: [
      { fromTeam: false, body: "Where's my invoice?" },
      { fromTeam: true, name: "Olive Owner", body: "In Billing → Invoices." },
    ],
  });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ unseen: 0 }] });

  // Writing again opens it again for the team.
  await call(updateConversation, team, { number: 1, status: "closed" });
  expect(await widgetSendMessage(project.slug, auth, 1, "Found it, thanks!")).toEqual({});
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ status: "OPEN" });
});

test("the team's notes are theirs alone: the user never sees one, counts it unseen, or sees their conversation move", async () => {
  const { project, team, auth } = await setup();
  await widgetStartConversation(project.slug, auth, "Where's my invoice?");
  await call(replyToConversation, team, { number: 1, body: "In Billing → Invoices." });
  await widgetConversation(project.slug, auth, 1);
  const before = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });

  const note = await call(replyToConversation, team, { number: 1, body: "They're on the old plan: check with billing.", note: true });
  expect(note).toMatchObject({ author: "team", note: true });
  // Nobody replied: the status, how long they've waited and the last message's time stay as they were.
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({
    status: before.status,
    waitingSince: before.waitingSince,
    lastMessageAt: before.lastMessageAt,
  });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ unseen: 0, lastMessageAt: before.lastMessageAt }], unseen: 0 });
  expect((await widgetConversation(project.slug, auth, 1)) as { messages: { body: string }[] }).toMatchObject({
    messages: [{ body: "Where's my invoice?" }, { body: "In Billing → Invoices." }],
  });
  expect(((await widgetConversation(project.slug, auth, 1)) as { messages: unknown[] }).messages).toHaveLength(2);
  // The team still sees it, as a note.
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, note: true, author: "TEAM" } })).toBe(1);

  // Only the team writes notes, never on a user's behalf.
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: team.actor.userId }, projectId: project.id };
  await expect(call(replyToConversation, key, { number: 1, body: "Psst", note: true, author: { id: "user-42" } })).rejects.toMatchObject({ status: 400 });
});

test("nobody reaches another person's conversations, another project's, or any with the inbox off", async () => {
  const { project, auth } = await setup();
  await widgetStartConversation(project.slug, auth, "Mine");
  const someoneElse = { token: widgetToken(project.id, await upsertProjectUser(project.id, "user-43", { name: "Kim" })) };

  expect(await widgetConversations(project.slug, someoneElse)).toEqual({ conversations: [], unseen: 0 });
  expect(await widgetConversation(project.slug, someoneElse, 1)).toEqual({ error: "Conversation not found" });
  expect(await widgetSendMessage(project.slug, someoneElse, 1, "Hi")).toEqual({ error: "Conversation not found" });

  // A token for another project, a made-up one, or none (and nobody signed in on the portal).
  const other = await setup();
  for (const bad of [other.auth, { token: "not-a-token" }, { visitor: "not-a-token" }, {}]) {
    expect(await widgetConversations(project.slug, bad)).toMatchObject(signInFirst);
    expect(await widgetConversation(project.slug, bad, 1)).toEqual(signInFirst);
  }
  // A widget token that doesn't check out isn't taken as someone signed out either.
  expect(await widgetStartConversation(project.slug, { token: "not-a-token" }, "Hi", "e2e-kim@example.com")).toEqual(signInFirst);

  const off = await setup(false);
  expect(await widgetConversations(off.project.slug, off.auth)).toEqual(signInFirst);
  expect(await widgetStartConversation(off.project.slug, {}, "Hi", "e2e-kim@example.com")).toEqual(signInFirst);
  expect(await prisma.conversation.count({ where: { projectId: { in: [other.project.id, off.project.id] } } })).toBe(0);
});

test("their list: only their own conversations in this project, newest first, each with its latest line and whether the team replied", async () => {
  const { project, team, auth } = await setup();
  await widgetStartConversation(project.slug, auth, "Where's my invoice?");
  await widgetStartConversation(project.slug, auth, "Can I change my plan?");
  await call(replyToConversation, team, { number: 1, body: "In Billing → Invoices.\n\nUnder this month." });
  // Someone else's here, and their own in another project, aren't in it.
  const kim = { token: widgetToken(project.id, await upsertProjectUser(project.id, "user-43", { name: "Kim" })) };
  await widgetStartConversation(project.slug, kim, "Kim's question");
  const other = await setup();
  await widgetStartConversation(other.project.slug, other.auth, "In the other project");

  expect(await widgetConversations(project.slug, auth)).toMatchObject({
    conversations: [
      { number: 1, subject: "Where's my invoice?", line: "In Billing → Invoices.", yours: false, replied: true },
      // Only their first message, which the subject already says.
      { number: 2, subject: "Can I change my plan?", line: undefined, yours: true, replied: false },
    ],
  });

  // They answer: it's theirs that's latest now, and a note of the team's after it changes nothing.
  await widgetSendMessage(project.slug, auth, 2, "Found it, thanks!");
  await prisma.conversationMessage.create({
    data: { projectId: project.id, conversationId: (await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 2 } })).id, author: "TEAM", channel: "APP", body: "Upsell?", note: true },
  });
  const listed = await widgetConversations(project.slug, auth);
  expect(listed).toMatchObject({ conversations: [{ number: 2, line: "Found it, thanks!", yours: true, replied: false }, { number: 1 }] });
  expect((listed as { conversations: unknown[] }).conversations).toHaveLength(2);

  // The AI's answer, as before "Ask a person", is latest: nobody of the team has replied.
  await prisma.conversationMessage.create({
    data: { projectId: project.id, conversationId: (await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 2 } })).id, author: "AI", channel: "APP", body: "Plans are in Billing." },
  });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({
    conversations: [{ number: 2, line: "Plans are in Billing.", yours: false, replied: false, closed: false }, { number: 1, closed: false }],
  });

  // The team closes it without writing again: it's closed, not waiting for a reply.
  await widgetSendMessage(project.slug, auth, 2, "Thanks, that fixed it!");
  await call(updateConversation, team, { number: 2, status: "closed" });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({
    conversations: [{ number: 2, line: "Thanks, that fixed it!", yours: true, replied: false, closed: true }, { number: 1, closed: false }],
  });
});

test("someone signed in on the portal itself uses their session", async () => {
  const { project } = await setup();
  const reader = await signUp("Riley Reader");
  actAs(reader);
  expect(await widgetStartConversation(project.slug, {}, "From the portal")).toEqual({ number: 1 });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ userId: reader.id });
});

test("someone signed out gives their email, gets a visitor token, and sees only their own conversations with it", async () => {
  const { project, team } = await setup();
  expect(await widgetStartConversation(project.slug, {}, "Hi", "not an email")).toEqual({ error: "Enter a valid email address" });

  const first = await widgetStartConversation(project.slug, {}, "Do you have a nonprofit discount?", " E2E-Kim@Example.com ");
  expect(first).toEqual({ number: 1, visitor: expect.any(String) });
  const visitor = { visitor: (first as { visitor: string }).visitor };
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(conversation).toMatchObject({ userId: null, email: "e2e-kim@example.com", emailVerified: false, visitorHash: expect.any(String) });
  // Only a hash is kept.
  expect(JSON.stringify(conversation)).not.toContain(visitor.visitor);

  await call(replyToConversation, team, { number: 1, body: "Yes, 50% off." });
  // Emailed to them since: still unseen here (the panel's their conversation, not an email thread).
  await prisma.conversationMessage.updateMany({ where: { projectId: project.id, author: "TEAM" }, data: { emailStatus: "SENT" } });
  expect(await widgetConversations(project.slug, visitor)).toMatchObject({ unseen: 1 });
  expect(await widgetConversation(project.slug, visitor, 1)).toMatchObject({ messages: [{ fromTeam: false }, { fromTeam: true, body: "Yes, 50% off." }] });
  expect(await widgetSendMessage(project.slug, visitor, 1, "Great!")).toEqual({});
  // A second conversation keeps the same token.
  expect(await widgetStartConversation(project.slug, visitor, "Another question", "e2e-kim@example.com")).toEqual({ number: 2 });
  expect(await widgetConversations(project.slug, visitor)).toMatchObject({ conversations: [{ number: 2 }, { number: 1 }] });

  // Another visitor sees none of it.
  const stranger = await widgetStartConversation(project.slug, {}, "Hello", "e2e-lee@example.com");
  const strangerAuth = { visitor: (stranger as { visitor: string }).visitor };
  expect(await widgetConversations(project.slug, strangerAuth)).toMatchObject({ conversations: [{ number: 3 }] });
  expect(await widgetConversation(project.slug, strangerAuth, 1)).toEqual({ error: "Conversation not found" });

  // With Messages off for now, the token isn't said to have run out: the panel keeps it for when they're back on.
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: false } });
  expect(await widgetConversations(project.slug, visitor)).toEqual(signInFirst);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });

  // A visitor token runs out after 30 days, and the answer says so (the panel then forgets it).
  vi.useFakeTimers({ now: Date.now() + 31 * 24 * 60 * 60_000, toFake: ["Date"] });
  try {
    expect(await widgetConversations(project.slug, visitor)).toEqual({ ...signInFirst, expired: true });
  } finally {
    vi.useRealTimers();
  }
});

test("a visitor using a user's email gets nothing of that user's", async () => {
  const { project, auth } = await setup();
  await widgetStartConversation(project.slug, auth, "Sam's own question");
  const posing = await widgetStartConversation(project.slug, {}, "Hi, it's Sam", "e2e-sam@example.com");
  const posingAuth = { visitor: (posing as { visitor: string }).visitor };

  // Not linked to Sam, and none of Sam's conversations are theirs.
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 2 } })).toMatchObject({ userId: null, emailVerified: false });
  expect(await widgetConversations(project.slug, posingAuth)).toMatchObject({ conversations: [{ number: 2 }] });
  expect(await widgetConversation(project.slug, posingAuth, 1)).toEqual({ error: "Conversation not found" });
  // Nor are theirs Sam's.
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: 1 }] });
});

test("new conversations are limited per day and per typed address, and messages per minute", async () => {
  const { project, auth, userId } = await setup();
  const conversation = await prisma.conversation.create({
    data: { projectId: project.id, number: 100, subject: "Old", origin: "WIDGET", userId },
  });
  await prisma.conversation.createMany({
    data: Array.from({ length: 18 }, (_, i) => ({ projectId: project.id, number: 101 + i, subject: "Old", origin: "WIDGET" as const, userId })),
  });
  // Started at once, one goes through and the others are refused (counted again under the project's lock).
  const atOnce = await Promise.all(["One", "Two", "Three"].map((text) => widgetStartConversation(project.slug, auth, text)));
  expect(atOnce.filter((r) => "number" in r)).toHaveLength(1);
  expect(atOnce.filter((r) => "error" in r)).toEqual([{ error: expect.stringContaining("Try again tomorrow") }, { error: expect.stringContaining("Try again tomorrow") }]);

  await prisma.conversationMessage.createMany({
    data: Array.from({ length: 28 }, () => ({ projectId: project.id, conversationId: conversation.id, author: "USER" as const, authorId: userId, channel: "WIDGET" as const, body: "x" })),
  });
  expect(await widgetSendMessage(project.slug, auth, 100, "Last one")).toEqual({});
  expect(await widgetSendMessage(project.slug, auth, 100, "Too fast")).toMatchObject({ error: expect.stringContaining("too fast") });

  // Signed out: an address gets a few new conversations an hour, like emailed links.
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await widgetStartConversation(project.slug, {}, `Question ${i}`, "e2e-busy@example.com"));
  }
  expect(results.slice(0, 5).every((r) => "number" in r)).toBe(true);
  expect(results[5]).toMatchObject({ error: expect.stringContaining("a lot of emails to this address") });
});

test("signed out, a new conversation on a site at its hourly limit for emails says so", async () => {
  const { project } = await setup();
  await prisma.signInLink.createMany({
    data: Array.from({ length: SIGN_IN_LINKS_PER_PORTAL_PER_HOUR }, (_, i) => ({ projectId: project.id, emailHash: `h${i}` })),
  });
  expect(await widgetStartConversation(project.slug, {}, "Hello?", "e2e-visitor@example.com")).toEqual({
    error: "This site has sent a lot of emails in the last hour. Try again later.",
  });
});

test("the total unseen count includes conversations older than the latest 50 the list shows", async () => {
  const { project, auth, userId } = await setup();
  const old = await prisma.conversation.create({
    data: { projectId: project.id, number: 1, subject: "Old", origin: "WIDGET", userId, lastMessageAt: new Date(Date.now() - 86_400_000) },
  });
  await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: old.id, author: "TEAM", channel: "APP", body: "Still there?" } });
  await prisma.conversation.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({ projectId: project.id, number: 2 + i, subject: "Newer", origin: "WIDGET" as const, userId })),
  });
  const listed = await widgetConversations(project.slug, auth);
  expect(listed).toMatchObject({ unseen: 1 });
  expect((listed as { conversations: { number: number }[] }).conversations.map((c) => c.number)).not.toContain(1);
});


test("the shown panel saying they're here makes them online, and tells the team's pages once", async () => {
  const { project, auth } = await setup();
  // Markers of our own: one heard means the listener's connected; and since NOTIFYs arrive in the
  // order they're sent, once the last one's heard, so is everything before it.
  const marker = (conversationId: string) => notifyInboxNow({ projectId: project.id, conversationId, userId: null, visitorHash: null });
  const heardOf = (wants: (conversationId: string) => boolean) => {
    const heard: number[] = [];
    stops.push(subscribeInbox((change) => change.projectId === project.id && wants(change.conversationId), () => heard.push(1)));
    return heard;
  };
  const stops: (() => void)[] = [];
  const connected = heardOf((id) => id === "connected");
  const last = heardOf((id) => id === "last");
  const heard = heardOf((id) => id !== "connected" && id !== "last");
  try {
    await vi.waitFor(async () => {
      await marker("connected");
      expect(connected.length).toBeGreaterThan(0);
    });
    expect(await widgetHere(project.slug, auth)).toEqual({});
    expect(await widgetHere(project.slug, auth)).toEqual({});
    await marker("last");
    await vi.waitFor(() => expect(last).toHaveLength(1));
    expect(heard).toHaveLength(1);
  } finally {
    stops.forEach((stop) => stop());
  }
  // Reading their conversations alone (a hidden panel's checks) doesn't make them online.
  const other = await setup();
  await widgetConversations(other.project.slug, other.auth);
  expect(await prisma.widgetPresence.count({ where: { projectId: other.project.id } })).toBe(0);
});

test("a conversation says whether it waits for a reply (never that it's spam) and the address its replies are emailed to once they've left: none for spam, or while no email can go out", async () => {
  const { project, team, auth } = await setup();
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email.example");
  vi.stubEnv("SMTP_HOST", "localhost");
  await widgetStartConversation(project.slug, auth, "Where's my invoice?");
  const started = await widgetStartConversation(project.slug, {}, "Is there a nonprofit discount?", "e2e-kim@example.com");
  const visitor = { visitor: "visitor" in started ? started.visitor : null };
  // No support address to send from: no email.
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ emailedTo: null });
  await mailSubdomain(project.id);
  // Someone the page signs in: the email their app gave; a visitor: the one they typed.
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ awaitingReply: true, emailedTo: "e2e-sam@example.com", replyMs: null });
  expect(await widgetConversation(project.slug, visitor, 2)).toMatchObject({ emailedTo: "e2e-kim@example.com" });
  // A server that doesn't send email (no SMTP, or no support email domain): none.
  vi.stubEnv("SMTP_HOST", "");
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ emailedTo: null });
  vi.stubEnv("SMTP_HOST", "localhost");
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "");
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ emailedTo: null });
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email.example");
  // Someone who marked the project's email as spam is emailed nothing more.
  await prisma.emailBlock.create({ data: { projectId: project.id, email: "e2e-sam@example.com" } });
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ emailedTo: null });
  await call(updateConversation, team, { number: 1, status: "closed" });
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({ awaitingReply: false });
  // Marked spam: no reply to wait for, nor email, and never told it's spam.
  await prisma.conversation.updateMany({ where: { projectId: project.id, number: 2 }, data: { spam: true } });
  const spam = await widgetConversation(project.slug, visitor, 2);
  expect(spam).toMatchObject({ awaitingReply: false, emailedTo: null });
  expect(spam).not.toHaveProperty("spam");
});

test("someone the page signs in also has the project's conversations from their address, verified: listed, counted, opened, seen and answered", async () => {
  const { project, team, auth, userId } = await setup();
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email.example");
  vi.stubEnv("SMTP_HOST", "localhost");
  await mailSubdomain(project.id);
  const byEmail = (email: string, body: string, verified = true, projectId = project.id) =>
    startConversation(projectId, { userId: null, email, body, origin: "EMAIL", channel: "EMAIL" }).then(({ conversation }) =>
      prisma.conversation.update({ where: { id: conversation.id }, data: { emailVerified: verified } }),
    );
  // #1: emailed in (DMARC passed); #2: their address given without proof (the API, or typed signed out); #3: from another address.
  await byEmail("e2e-sam@example.com", "Emailed: where's my invoice?");
  await byEmail("e2e-sam@example.com", "Unproven", false);
  await byEmail("e2e-kim@example.com", "Someone else's");
  // #4: from their address, but already with another user.
  const other = await upsertProjectUser(project.id, "user-43", { name: "Kim", email: "e2e-kim@example.com" });
  await startConversation(project.id, { userId: other, email: null, body: "Kim's own", origin: "WIDGET", channel: "WIDGET" });
  await prisma.conversation.update({ where: { projectId_number: { projectId: project.id, number: 4 } }, data: { email: "e2e-sam@example.com", emailVerified: true } });
  // Another project's, from their address, verified.
  const elsewhere = await createProject(await signUp("Other Owner"));
  await byEmail("e2e-sam@example.com", "Elsewhere", true, elsewhere.id);

  await call(replyToConversation, team, { number: 1, body: "In Billing → Invoices." });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: 1, replied: true, unseen: 1 }], unseen: 1 });
  // A reply that reached them by email is read there: not unseen (nor the launcher's dot); one whose email failed is.
  const reply = { conversation: { projectId: project.id, number: 1 }, author: "TEAM" as const };
  await prisma.conversationMessage.updateMany({ where: reply, data: { emailStatus: "DELIVERED" } });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: 1, unseen: 0 }], unseen: 0 });
  await prisma.conversationMessage.updateMany({ where: reply, data: { emailStatus: "FAILED" } });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: 1, unseen: 1 }], unseen: 1 });
  for (const number of [2, 3, 4]) {
    expect(await widgetConversation(project.slug, auth, number)).toEqual({ error: "Conversation not found" });
  }
  // Opened: seen, and the team's replies still go to the address it came from (theirs).
  expect(await widgetConversation(project.slug, auth, 1)).toMatchObject({
    emailedTo: "e2e-sam@example.com",
    messages: [{ fromTeam: false, body: "Emailed: where's my invoice?" }, { fromTeam: true, body: "In Billing → Invoices." }],
  });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ unseen: 0 });

  // Answered from the widget: in the same conversation, by them, still with the address.
  expect(await widgetSendMessage(project.slug, auth, 1, "Found it, thanks!")).toEqual({});
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { projectId_number: { projectId: project.id, number: 1 } },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  expect(conversation).toMatchObject({ userId: null, email: "e2e-sam@example.com", messages: [{ author: "USER", authorId: userId, channel: "WIDGET" }] });

  // A visitor who types the address, and a portal account with it verified, get none of it.
  const posing = await widgetStartConversation(project.slug, {}, "Hi, it's Sam", "e2e-sam@example.com");
  expect(await widgetConversation(project.slug, { visitor: (posing as { visitor: string }).visitor }, 1)).toEqual({ error: "Conversation not found" });
  // Nor does someone the page signs in get a visitor's, even were its address verified: it's the visitor's.
  const posed = (posing as { number: number }).number;
  await prisma.conversation.update({ where: { projectId_number: { projectId: project.id, number: posed } }, data: { emailVerified: true } });
  expect(await widgetConversation(project.slug, auth, posed)).toEqual({ error: "Conversation not found" });
  const account = await signUp("Sam Elsewhere", "e2e-sam@example.com");
  await prisma.user.update({ where: { id: account.id }, data: { emailVerified: true } });
  actAs(account);
  expect(await widgetConversation(project.slug, {}, 1)).toEqual({ error: "Conversation not found" });

  // Signed in on the portal itself by the project's SSO with the address: theirs there too, as on the customer's site.
  const portalSam = await signUp("Sam on the portal");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-portal-sam", userId: portalSam.id, email: "e2e-sam@example.com" } });
  actAs(portalSam);
  expect(await widgetConversations(project.slug, {})).toMatchObject({ conversations: [{ number: 1 }] });
  expect(await widgetConversation(project.slug, {}, 1)).toMatchObject({ messages: [{ body: "Emailed: where's my invoice?" }, expect.anything(), expect.anything()] });
});

test("someone the page signs in hears live of changes to conversations from their address", async () => {
  const { project, team, auth, userId } = await setup();
  const who = (await widgetPerson(project.slug, auth))!;
  const change = { projectId: project.id, conversationId: "c", userId: null, visitorHash: null };
  expect(hears(who, { ...change, email: "e2e-sam@example.com" })).toBe(true);
  expect(hears(who, { ...change, userId })).toBe(true);
  expect(hears(who, { ...change, email: "e2e-kim@example.com" })).toBe(false);
  expect(hears(who, { ...change, email: "e2e-sam@example.com", visitorHash: "h" })).toBe(false);
  expect(hears(who, { ...change, email: "e2e-sam@example.com", projectId: "elsewhere" })).toBe(false);

  // One by email coming in, the team's reply to it, and its closing each say its address. NOTIFYs arrive in order:
  // once a marker sent after a step is heard, so is all that step said.
  const heard: string[] = [];
  const stop = subscribeInbox((c) => c.projectId === project.id && (c.conversationId.startsWith("marker") || hears(who, c)) && !!heard.push(c.conversationId), () => {});
  let markers = 0;
  const heardOf = async (step: () => Promise<unknown>) => {
    heard.length = 0;
    await step();
    const marker = `marker-${++markers}`;
    await notifyInboxNow({ ...change, conversationId: marker });
    await vi.waitFor(() => expect(heard).toContain(marker));
    return heard.filter((id) => !id.startsWith("marker"));
  };
  try {
    await vi.waitFor(async () => {
      await notifyInboxNow({ ...change, conversationId: "marker-connected" });
      expect(heard.length).toBeGreaterThan(0);
    });
    let id = "";
    let number = 0;
    expect(
      await heardOf(async () => {
        ({ id, number } = (await startConversation(project.id, { userId: null, email: "e2e-sam@example.com", body: "Emailed", origin: "EMAIL", channel: "EMAIL" })).conversation);
      }),
    ).toContain(id);
    expect(await heardOf(() => call(replyToConversation, team, { number, body: "Got it" }))).toContain(id);
    expect(await heardOf(() => call(updateConversation, team, { number, status: "closed" }))).toContain(id);
  } finally {
    stop();
  }
});

test("a signed-out visitor who types someone else's address never reads that person's emailed reply in the widget", async () => {
  const { project, team } = await setup();
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  const subdomain = await mailSubdomain(project.id);
  // The visitor gives an address that isn't theirs: never verified, and the conversation is still their token's.
  const started = await widgetStartConversation(project.slug, {}, "Please confirm the billing email on file", "e2e-victim@example.com");
  const visitor = { visitor: (started as { visitor: string }).visitor };
  await call(replyToConversation, team, { number: 1, body: "Which account is it?" });

  // The team's reply is emailed to that address; someone forges an answer from it first (DMARC fails: to Spam).
  const { replyToken } = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id, number: 1 } });
  const replyAddress = supportAddress(subdomain, "tuti.email", replyToken);
  const forged = rawEmail({ from: "e2e-victim@example.com", to: replyAddress, subject: "Re: Please confirm", body: "Forged" });
  expect(await postEmail(forged, { recipient: replyAddress, auth: "spf=fail dkim=fail dmarc=fail" })).toEqual({ status: 200, body: { outcome: "added" } });
  // Its owner answers it (DMARC passes: it's really from them).
  const raw = rawEmail({ from: "e2e-victim@example.com", to: replyAddress, subject: "Re: Please confirm", body: "I never asked. My account is private-details." });
  expect(await postEmail(raw, { recipient: replyAddress })).toEqual({ status: 200, body: { outcome: "added" } });

  // The visitor's token proves nothing about who owns the address: their view never shows the owner's email.
  const opened = await widgetConversation(project.slug, visitor, 1);
  expect(opened).toMatchObject({ messages: expect.any(Array) });
  expect(JSON.stringify(opened)).not.toContain("private-details");
  // The team answers in the visitor's conversation again; the owner's next email goes on in their own, not a third.
  await call(replyToConversation, team, { number: 1, body: "Sorry, could you check?" });
  const again = rawEmail({ from: "e2e-victim@example.com", to: replyAddress, subject: "Re: Please confirm", body: "Still private-details." });
  expect(await postEmail(again, { recipient: replyAddress })).toEqual({ status: 200, body: { outcome: "added" } });
  expect(JSON.stringify(await widgetConversation(project.slug, visitor, 1))).not.toContain("private-details");
  // The team still has it: a conversation of its own with the address's owner, verified, beside the visitor's.
  const all = await prisma.conversation.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: { number: true, email: true, emailVerified: true, visitorHash: true, messages: { orderBy: { createdAt: "asc" }, select: { body: true } } },
  });
  expect(all.map(({ visitorHash, messages, ...c }) => ({ ...c, visitor: !!visitorHash, bodies: messages.map((m) => m.body) }))).toEqual([
    {
      number: 1,
      email: "e2e-victim@example.com",
      emailVerified: false,
      visitor: true,
      bodies: ["Please confirm the billing email on file", "Which account is it?", "Sorry, could you check?"],
    },
    { number: 2, email: "e2e-victim@example.com", emailVerified: false, visitor: false, bodies: ["Forged"] },
    { number: 3, email: "e2e-victim@example.com", emailVerified: true, visitor: false, bodies: ["I never asked. My account is private-details.", "Still private-details."] },
  ]);
});
