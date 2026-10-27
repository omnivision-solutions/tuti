import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";

import { replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { widgetConversation, widgetConversations, widgetSendMessage, widgetStartConversation } from "./widget-inbox";

async function setup(inbox = true) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: inbox } });
  const userId = await upsertProjectUser(project.id, "user-42", { name: "Sam" });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  return { owner, project, team, userId, token: widgetToken(project.id, userId) };
}

test("someone the page signs in writes to the team, sees replies, and seeing them clears the count", async () => {
  const { project, team, token } = await setup();
  expect(await widgetConversations(project.slug, token)).toEqual({ conversations: [], unseen: 0 });

  const started = await widgetStartConversation(project.slug, token, "Where's my invoice?");
  expect(started).toEqual({ number: 1 });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ origin: "WIDGET", status: "OPEN" });

  await call(replyToConversation, team, { number: 1, body: "In Billing → Invoices." });
  expect(await widgetConversations(project.slug, token)).toMatchObject({ conversations: [{ number: 1, subject: "Where's my invoice?", unseen: 1 }], unseen: 1 });

  const opened = await widgetConversation(project.slug, token, 1);
  expect(opened).toMatchObject({
    messages: [
      { fromTeam: false, body: "Where's my invoice?" },
      { fromTeam: true, name: "Olive Owner", body: "In Billing → Invoices." },
    ],
  });
  expect(await widgetConversations(project.slug, token)).toMatchObject({ conversations: [{ unseen: 0 }] });

  // Writing again opens it again for the team.
  await call(updateConversation, team, { number: 1, status: "closed" });
  expect(await widgetSendMessage(project.slug, token, 1, "Found it, thanks!")).toEqual({});
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ status: "OPEN" });
});

test("nobody reaches another person's conversations, another project's, or any with the inbox off", async () => {
  const { project, token } = await setup();
  await widgetStartConversation(project.slug, token, "Mine");
  const someoneElse = widgetToken(project.id, await upsertProjectUser(project.id, "user-43", { name: "Kim" }));

  expect(await widgetConversations(project.slug, someoneElse)).toEqual({ conversations: [], unseen: 0 });
  expect(await widgetConversation(project.slug, someoneElse, 1)).toEqual({ error: "Conversation not found" });
  expect(await widgetSendMessage(project.slug, someoneElse, 1, "Hi")).toEqual({ error: "Conversation not found" });

  // A token for another project, a made-up one, or none (and nobody signed in on the portal).
  const other = await setup();
  actAs(null);
  for (const bad of [other.token, "not-a-token", null]) {
    expect(await widgetConversations(project.slug, bad)).toEqual({ error: "Sign in to message the team" });
    expect(await widgetStartConversation(project.slug, bad, "Hi")).toEqual({ error: "Sign in to message the team" });
  }

  const off = await setup(false);
  expect(await widgetConversations(off.project.slug, off.token)).toEqual({ error: "Sign in to message the team" });
  expect(await prisma.conversation.count({ where: { projectId: { in: [other.project.id, off.project.id] } } })).toBe(0);
});

test("someone signed in on the portal itself uses their session", async () => {
  const { project } = await setup();
  const reader = await signUp("Riley Reader");
  actAs(reader);
  expect(await widgetStartConversation(project.slug, null, "From the portal")).toEqual({ number: 1 });
  expect(await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ userId: reader.id });
});

test("new conversations are limited per day, and messages per minute", async () => {
  const { project, token, userId } = await setup();
  const conversation = await prisma.conversation.create({
    data: { projectId: project.id, number: 100, subject: "Old", origin: "WIDGET", userId },
  });
  await prisma.conversation.createMany({
    data: Array.from({ length: 18 }, (_, i) => ({ projectId: project.id, number: 101 + i, subject: "Old", origin: "WIDGET" as const, userId })),
  });
  expect(await widgetStartConversation(project.slug, token, "One more")).toEqual({ number: 1 });
  expect(await widgetStartConversation(project.slug, token, "Too many")).toMatchObject({ error: expect.stringContaining("Try again tomorrow") });

  await prisma.conversationMessage.createMany({
    data: Array.from({ length: 28 }, () => ({ projectId: project.id, conversationId: conversation.id, author: "USER" as const, authorId: userId, channel: "WIDGET" as const, body: "x" })),
  });
  expect(await widgetSendMessage(project.slug, token, 100, "Last one")).toEqual({});
  expect(await widgetSendMessage(project.slug, token, 100, "Too fast")).toMatchObject({ error: expect.stringContaining("too fast") });
});

test("the total unseen count includes conversations older than the latest 50 the list shows", async () => {
  const { project, token, userId } = await setup();
  const old = await prisma.conversation.create({
    data: { projectId: project.id, number: 1, subject: "Old", origin: "WIDGET", userId, lastMessageAt: new Date(Date.now() - 86_400_000) },
  });
  await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: old.id, author: "TEAM", channel: "APP", body: "Still there?" } });
  await prisma.conversation.createMany({
    data: Array.from({ length: 50 }, (_, i) => ({ projectId: project.id, number: 2 + i, subject: "Newer", origin: "WIDGET" as const, userId })),
  });
  const listed = await widgetConversations(project.slug, token);
  expect(listed).toMatchObject({ unseen: 1 });
  expect((listed as { conversations: { number: number }[] }).conversations.map((c) => c.number)).not.toContain(1);
});

