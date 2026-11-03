import { type ConversationStatus, prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { createProject, signUp } from "@/test/helpers";

import { OperationError } from "./operations/define";
import { addMessage, getConversation, listConversations } from "./operations/conversations";
import { aiReport } from "./operations/reports";
import { call } from "./operations/run";
import { listUsers } from "./operations/users";
import { upsertProjectUser } from "./project-users";
import { widgetConversation, widgetConversations } from "./widget-inbox";

/** Inbox and AI conversation history by plan (docs/plan.md, Plans): hidden past the plan's days, deleted past the longest. */

let s3: S3Fake;
beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());
afterEach(() => vi.unstubAllEnvs());

const quiet = { info: () => {}, warn: () => {} };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const userId = await upsertProjectUser(project.id, "user-42", { name: "Sam", email: `e2e-sam-${project.slug}@example.com` });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  let number = 0;
  /** A conversation of Sam's, last written in `days` ago. */
  const conversation = (days: number, status: ConversationStatus, more: { snoozedUntil?: Date; spam?: boolean } = {}) =>
    prisma.conversation.create({
      data: { projectId: project.id, number: ++number, subject: `#${number}`, origin: "WIDGET", userId, status, lastMessageAt: daysAgo(days), ...more },
    });
  const plan = (plan: "FREE" | "PRO" | "BUSINESS") => prisma.project.update({ where: { id: project.id }, data: { plan } });
  const listed = async () => (await call(listConversations, team, {})).conversations.map((c) => c.number).sort((a, b) => a - b);
  return { project, team, userId, conversation, plan, listed, auth: { token: widgetToken(project.id, userId) } };
}

test("with plans, closed conversations past the plan's history are hidden; open, snoozed and waiting ones never; a message or an upgrade shows them again", async () => {
  vi.stubEnv("PLANS", "on");
  const { project, team, conversation, plan, listed } = await setup();
  const closed10 = await conversation(10, "CLOSED"); // #1
  await conversation(100, "OPEN"); // #2
  await conversation(100, "WAITING"); // #3
  await conversation(100, "OPEN", { snoozedUntil: daysAgo(-1) }); // #4
  await conversation(3, "CLOSED"); // #5
  await conversation(40, "CLOSED"); // #6

  // Free: 7 days.
  expect(await listed()).toEqual([2, 3, 4, 5]);
  await expect(call(getConversation, team, { number: 1 })).rejects.toThrow(
    new OperationError(404, "not_found", "Conversation #1 is past your plan's history: upgrade to see it again"),
  );
  await expect(call(getConversation, team, { number: 99 })).rejects.toThrow(new OperationError(404, "not_found", "There's no conversation #99"));

  // Pro: 30 days; Business: 90.
  await plan("PRO");
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  await plan("BUSINESS");
  expect(await listed()).toEqual([1, 2, 3, 4, 5, 6]);

  // Back on Free with a longer history set for it.
  await plan("FREE");
  vi.stubEnv("HISTORY_DAYS_FREE", "14");
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  vi.stubEnv("HISTORY_DAYS_FREE", "");

  // An email reply joins the hidden one: it's open, and shows again.
  expect(await listed()).toEqual([2, 3, 4, 5]);
  await addMessage(closed10.id, project.id, { author: "USER", authorId: null, channel: "EMAIL", body: "One more thing" });
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  expect((await call(getConversation, team, { number: 1 })).messages.map((m) => m.body)).toEqual(["One more thing"]);

  // Without plans, all of them.
  vi.stubEnv("PLANS", "");
  expect(await listed()).toEqual([1, 2, 3, 4, 5, 6]);
});

test("the widget's Messages and Users' counts leave out what's past the plan's history", async () => {
  vi.stubEnv("PLANS", "on");
  const { project, team, conversation, plan, auth } = await setup();
  await conversation(10, "CLOSED");
  await conversation(1, "CLOSED");
  const numbers = async () => {
    const result = await widgetConversations(project.slug, auth);
    return "conversations" in result ? result.conversations.map((c) => c.number) : result;
  };
  const counted = async () => (await call(listUsers, team, {})).users[0]!.activity.conversations;

  expect(await numbers()).toEqual([2]);
  expect(await widgetConversation(project.slug, auth, 1)).toHaveProperty("error");
  expect(await counted()).toBe(1);

  await plan("PRO");
  expect(await numbers()).toEqual([2, 1]);
  expect(await widgetConversation(project.slug, auth, 1)).toHaveProperty("subject", "#1");
  expect(await counted()).toBe(2);
});

test("Reporting's AI conversations lists those asked in within the plan's history; its totals stay as they are", async () => {
  vi.stubEnv("PLANS", "on");
  const { project, plan } = await setup();
  const asked = (question: string, days: number) =>
    prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", status: "ANSWERED", question, createdAt: daysAgo(days) } });
  await asked("Recent", 1);
  await asked("Older", 10);
  const questions = async () => (await aiReport(project.id)).conversations.map((c) => c.turns[0]!.question);

  expect(await questions()).toEqual(["Recent"]);
  expect((await aiReport(project.id)).totals.conversations).toBe(2);
  await plan("PRO");
  expect(await questions()).toEqual(["Recent", "Older"]);
  vi.stubEnv("PLANS", "");
  await plan("FREE");
  expect(await questions()).toEqual(["Recent", "Older"]);
});

test("the daily job deletes closed conversations and AI questions past the longest plan's history, with their attachments' files; nothing without plans", async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  const { project, conversation } = await setup();
  const old = await conversation(100, "CLOSED"); // #1
  await conversation(100, "OPEN"); // #2
  await conversation(50, "CLOSED"); // #3
  await conversation(100, "OPEN", { spam: true }); // #4
  const message = await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: old.id, author: "USER", channel: "EMAIL", body: "Old" } });
  const key = `attachments/${project.id}/old.pdf`;
  s3.objects.set(key, { body: Buffer.from("%PDF"), contentType: "application/pdf" });
  await prisma.conversationAttachment.create({ data: { projectId: project.id, messageId: message.id, key, filename: "old.pdf", contentType: "application/pdf", size: 4 } });
  for (const [question, days] of [["Old", 100], ["Kept", 50]] as const) {
    await prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", question, createdAt: daysAgo(days) } });
  }
  const left = async () => ({
    conversations: (await prisma.conversation.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } })).map((c) => c.number),
    questions: (await prisma.docsQuestion.findMany({ where: { projectId: project.id } })).map((q) => q.question).sort(),
    file: s3.objects.has(key),
  });

  // Self-hosted: kept forever.
  expect(await handlers.deleteOldHistory({}, quiet)).toEqual({ skipped: true });
  expect(await left()).toEqual({ conversations: [1, 2, 3, 4], questions: ["Kept", "Old"], file: true });

  vi.stubEnv("PLANS", "on");
  expect(await handlers.deleteOldHistory({}, quiet)).toMatchObject({ conversations: 2, files: 1, failedFiles: 0, questions: 1 });
  expect(await left()).toEqual({ conversations: [2, 3], questions: ["Kept"], file: false });
  expect(await prisma.conversationMessage.count({ where: { conversationId: old.id } })).toBe(0);
});
