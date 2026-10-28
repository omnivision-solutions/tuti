import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";

import { replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { notifyInboxNow, subscribeInbox } from "./live";
import { widgetConversation, widgetConversations, widgetHere, widgetSendMessage, widgetStartConversation } from "./widget-inbox";

async function setup(inbox = true) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: inbox } });
  const userId = await upsertProjectUser(project.id, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  actAs(null);
  return { owner, project, team, userId, auth: { token: widgetToken(project.id, userId) } };
}

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
