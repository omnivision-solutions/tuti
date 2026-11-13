import { readFileSync } from "node:fs";

import { type ConversationStatus, prisma } from "@tuti/db";
import { handlers, pastConversations } from "@tuti/jobs";
import { billingFile, type S3Fake, startS3Fake } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { reportRange } from "@/lib/report-range";
import { widgetToken } from "@/lib/widget-session";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { OperationError } from "./operations/define";
import ConversationPage from "@/app/app/(workspace)/[project]/inbox/[number]/page";
import TeamPostPage from "@/app/app/(workspace)/[project]/p/[number]/page";
import { PersonPanel } from "@/components/inbox/person-panel";

import { searchApp } from "./app-search";
import { removeMember } from "./team";
import { addMessage, getConversation, listConversations, replyToConversation, updateConversation } from "./operations/conversations";
import { aiReport } from "./operations/reports";
import { call } from "./operations/run";
import { listUsers } from "./operations/users";
import { upsertProjectUser } from "./project-users";
import { widgetConversation, widgetConversations, widgetStartConversation } from "./widget-inbox";

// The post page's client parts, rendered here without Next's router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

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
  /** A conversation of Sam's, last written in (and last active) `days` ago. */
  const conversation = (days: number, status: ConversationStatus, more: { snoozedUntil?: Date; spam?: boolean; assigneeId?: string } = {}) =>
    prisma.conversation.create({
      data: {
        projectId: project.id,
        number: ++number,
        subject: `Subject ${number}`,
        origin: "WIDGET",
        userId,
        status,
        lastMessageAt: daysAgo(days),
        activeAt: daysAgo(days),
        updatedAt: daysAgo(days),
        ...more,
      },
    });
  const plan = (plan: null | "pro" | "business") => prisma.project.update({ where: { id: project.id }, data: { plan } });
  const listed = async () => (await call(listConversations, team, {})).conversations.map((c) => c.number).sort((a, b) => a - b);
  return { owner, project, team, userId, conversation, plan, listed, auth: { token: widgetToken(project.id, userId) } };
}

test("with plans, closed conversations past the plan's history are hidden; open, snoozed and waiting ones never; a message or an upgrade shows them again", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
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
  await plan("pro");
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  await plan("business");
  expect(await listed()).toEqual([1, 2, 3, 4, 5, 6]);

  // Back on Free with a longer history set for it.
  await plan(null);
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free }) => { free.limits.historyDays = 14; }));
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  vi.stubEnv("BILLING_CONFIG", billingFile());

  // An email reply joins the hidden one: it's open, and shows again.
  expect(await listed()).toEqual([2, 3, 4, 5]);
  await addMessage(closed10.id, project.id, { author: "USER", authorId: null, channel: "EMAIL", body: "One more thing" });
  expect(await listed()).toEqual([1, 2, 3, 4, 5]);
  expect((await call(getConversation, team, { number: 1 })).messages.map((m) => m.body)).toEqual(["One more thing"]);

  // Closing one whose last message is old, or marking it spam, doesn't hide it: that was just done.
  await call(updateConversation, team, { number: 3, status: "closed" });
  await call(updateConversation, team, { number: 2, spam: true });
  expect(await listed()).toEqual([1, 3, 4, 5]);
  expect((await call(listConversations, team, { spam: "true" })).conversations.map((c) => c.number)).toEqual([2]);
  await prisma.conversation.updateMany({ where: { projectId: project.id, number: { in: [2, 3] } }, data: { activeAt: daysAgo(10), updatedAt: daysAgo(10) } });
  expect(await listed()).toEqual([1, 4, 5]);
  expect((await call(listConversations, team, { spam: "true" })).conversations).toEqual([]);

  // Without plans, all of them.
  vi.stubEnv("BILLING_CONFIG", "");
  expect(await listed()).toEqual([1, 3, 4, 5, 6]);
});

test("the team's Send and close on a conversation waiting 100 days keeps it: the reply is activity", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, conversation, listed } = await setup();
  const waiting = await conversation(100, "OPEN");
  await addMessage(waiting.id, project.id, { author: "TEAM", authorId: owner.id, channel: "APP", body: "Fixed" }, undefined, { close: true });
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("CLOSED");
  expect(await listed()).toEqual([1]);
  await handlers.deleteOldHistory({}, quiet);
  expect(await prisma.conversation.count({ where: { id: waiting.id } })).toBe(1);
});

test("search, a person's conversations and a post's linked ones leave out what's past the plan's history", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, userId, conversation, plan } = await setup();
  const old = await conversation(10, "CLOSED");
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode" } });
  await prisma.conversationPost.create({ data: { conversationId: old.id, postId: post.id } });
  actAs(owner);
  const found = async (q: string) => ((await searchApp(project.slug, q)).results ?? []).filter((r) => r.kind === "conversation").map((r) => r.title);
  const panel = async () => renderToStaticMarkup(await PersonPanel({ projectId: project.id, slug: project.slug, person: { userId, email: null, emailVerified: false } }));
  const postPage = async () =>
    renderToStaticMarkup(await TeamPostPage({ params: Promise.resolve({ project: project.slug, number: "1" }), searchParams: Promise.resolve({}) } as never));

  expect(await found("Subject")).toEqual([]);
  expect(await found("#1")).toEqual([]);
  expect(await panel()).not.toContain("Subject 1");
  expect(await postPage()).not.toContain("Subject 1");

  await plan("pro");
  expect(await found("Subject")).toEqual(["Subject 1"]);
  expect(await found("#1")).toEqual(["Subject 1"]);
  expect(await panel()).toContain("Subject 1");
  expect(await postPage()).toContain("Subject 1");
});

test("a signed-out visitor's Messages leave out what's past the plan's history", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { project } = await setup();
  actAs(null);
  const started = await widgetStartConversation(project.slug, {}, "Where's my invoice?", "e2e-visitor@example.com");
  if (!("visitor" in started) || !started.visitor) {
    throw new Error(`no visitor: ${JSON.stringify(started)}`);
  }
  const auth = { visitor: started.visitor };
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { status: "CLOSED", activeAt: daysAgo(10), updatedAt: daysAgo(10), lastMessageAt: daysAgo(10) } });
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [] });
  vi.stubEnv("BILLING_CONFIG", "");
  expect(await widgetConversations(project.slug, auth)).toMatchObject({ conversations: [{ number: started.number }] });
});

test("the widget's Messages and Users' counts leave out what's past the plan's history", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
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

  await plan("pro");
  expect(await numbers()).toEqual([2, 1]);
  expect(await widgetConversation(project.slug, auth, 1)).toHaveProperty("subject", "Subject 1");
  expect(await counted()).toBe(2);
});

test("Reporting's AI conversations lists those asked in within the plan's history; its totals stay as they are", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { project, plan } = await setup();
  const asked = (question: string, days: number) =>
    prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", status: "ANSWERED", question, createdAt: daysAgo(days) } });
  await asked("Recent", 1);
  await asked("Older", 10);
  const questions = async () => (await aiReport(project.id, reportRange(undefined))).conversations.map((c) => c.turns[0]!.question);

  expect(await questions()).toEqual(["Recent"]);
  // The one left out is said, not just missing.
  expect((await aiReport(project.id, reportRange(undefined))).pastHistory).toBe(1);
  expect((await aiReport(project.id, reportRange(undefined))).totals.conversations).toBe(2);
  await plan("pro");
  expect(await questions()).toEqual(["Recent", "Older"]);
  expect((await aiReport(project.id, reportRange(undefined))).pastHistory).toBe(0);
  vi.stubEnv("BILLING_CONFIG", "");
  await plan(null);
  expect(await questions()).toEqual(["Recent", "Older"]);
});

test("Reporting's Past year still counts AI conversations past every plan's history after the daily job: they're kept a year", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { project } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  for (const days of [10, 200]) {
    await prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", status: "ANSWERED", question: `${days}`, createdAt: daysAgo(days) } });
  }
  await handlers.deleteOldHistory({}, quiet);
  expect((await aiReport(project.id, reportRange("year"))).totals.conversations).toBe(2);
});

test("the daily job deletes closed conversations and AI questions after a year (historyKeptDays), with their attachments' files; nothing without plans", async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  const { project, conversation } = await setup();
  const old = await conversation(400, "CLOSED"); // #1
  await conversation(400, "OPEN"); // #2
  await conversation(100, "CLOSED"); // #3: past every plan's history, hidden, but kept for Reporting's Past year
  await conversation(400, "OPEN", { spam: true }); // #4
  // From before `activeAt`, closed just now, its last message as old: kept (its updatedAt stands in).
  await prisma.conversation.update({ where: { id: (await conversation(400, "CLOSED")).id }, data: { activeAt: null, updatedAt: new Date() } }); // #5
  const message = await prisma.conversationMessage.create({ data: { projectId: project.id, conversationId: old.id, author: "USER", channel: "EMAIL", body: "Old" } });
  const key = `attachments/${project.id}/old.pdf`;
  s3.objects.set(key, { body: Buffer.from("%PDF"), contentType: "application/pdf" });
  await prisma.conversationAttachment.create({ data: { projectId: project.id, messageId: message.id, key, filename: "old.pdf", contentType: "application/pdf", size: 4 } });
  for (const [question, days] of [["Old", 400], ["Kept", 100]] as const) {
    await prisma.docsQuestion.create({ data: { projectId: project.id, askerId: "x", source: "WIDGET", question, createdAt: daysAgo(days) } });
  }
  const left = async () => ({
    conversations: (await prisma.conversation.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } })).map((c) => c.number),
    questions: (await prisma.docsQuestion.findMany({ where: { projectId: project.id } })).map((q) => q.question).sort(),
    file: s3.objects.has(key),
  });

  // Self-hosted: kept forever.
  vi.stubEnv("BILLING_CONFIG", "");
  expect(await handlers.deleteOldHistory({}, quiet)).toEqual({ skipped: true });
  expect(await left()).toEqual({ conversations: [1, 2, 3, 4, 5], questions: ["Kept", "Old"], file: true });

  vi.stubEnv("BILLING_CONFIG", billingFile());
  // Its totals count every project's (other tests leave theirs): what's left of this one's says what it deleted.
  expect(await handlers.deleteOldHistory({}, quiet)).toMatchObject({ failedFiles: 0 });
  expect(await left()).toEqual({ conversations: [2, 3, 5], questions: ["Kept"], file: false });
  // Kept less long: as long as Business's 90 days, the least the file allows, so #3 (100 days) goes.
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.historyKeptDays = 90; }));
  await handlers.deleteOldHistory({}, quiet);
  expect((await left()).conversations).toEqual([2, 5]);
  expect(await prisma.conversationMessage.count({ where: { conversationId: old.id } })).toBe(0);
});

test("a teammate leaving doesn't show their old closed conversations again: being unassigned isn't something done in it", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, conversation, listed } = await setup();
  const member = await addMember(project.id, "MEMBER");
  actAs(owner);
  await conversation(10, "CLOSED", { assigneeId: member.id });
  expect(await listed()).toEqual([]);
  expect(await removeMember(project.slug, member.memberId)).toEqual({});
  expect(await prisma.teamMember.count({ where: { projectId: project.id, userId: member.id } })).toBe(0);
  expect(await listed()).toEqual([]);
});

test("the migration dates conversations from before activeAt by their updatedAt, so a teammate leaving no longer shows them again", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, conversation, listed } = await setup();
  const member = await addMember(project.id, "MEMBER");
  actAs(owner);
  const { id } = await conversation(10, "CLOSED", { assigneeId: member.id });
  const before = await prisma.conversation.update({ where: { id }, data: { activeAt: null, updatedAt: daysAgo(10) } });
  // One since #526: its activity recorded, its updatedAt moved later (a teammate leaving, say).
  const since = await prisma.conversation.update({ where: { id: (await conversation(20, "CLOSED")).id }, data: { updatedAt: new Date() } });

  await prisma.$executeRawUnsafe(
    readFileSync(new URL("../../../../packages/db/prisma/migrations/20261103180000_conversation_active_at_filled/migration.sql", import.meta.url), "utf8"),
  );

  expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).activeAt).toEqual(before.updatedAt);
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: since.id } })).activeAt).toEqual(since.activeAt);
  expect(since.activeAt).not.toEqual(since.updatedAt);
  expect(await removeMember(project.slug, member.memberId)).toEqual({});
  expect(await listed()).toEqual([]);
});

test("a message written as its user through the API joins a conversation past the plan's history, as their email would, and shows it again", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, team, conversation, listed } = await setup();
  await conversation(10, "CLOSED");
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  // The team's reply still can't find it.
  await expect(call(replyToConversation, key, { number: 1, body: "Hello?" })).rejects.toThrow("past your plan's history");
  await call(replyToConversation, key, { number: 1, body: "It's broken again", author: { id: "user-42" } });
  expect(await listed()).toEqual([1]);
  expect((await call(getConversation, team, { number: 1 })).messages.map((m) => m.body)).toEqual(["It's broken again"]);
});

test("past the plan's history, an upgrade is offered only while some plan would show it: an owner sees See plans, a member who to ask", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { owner, project, team, conversation, plan } = await setup();
  await conversation(10, "CLOSED"); // #1: Pro shows it.
  await conversation(100, "CLOSED"); // #2: past every plan's (the job deletes it tonight).
  // The page's conversation pane (beside the Inbox's list, which renders on its own).
  const page = async (number: number) =>
    renderToStaticMarkup(
      (await ConversationPage({ params: Promise.resolve({ project: project.slug, number: String(number) }), searchParams: Promise.resolve({}) } as never)).props
        .children,
    );
  const upgrade = "Upgrade to see it again.";

  actAs(owner);
  expect(await page(1)).toContain(upgrade);
  expect(await page(1)).toContain("See plans");
  await expect(call(getConversation, team, { number: 1 })).rejects.toThrow(
    new OperationError(404, "not_found", "Conversation #1 is past your plan's history: upgrade to see it again"),
  );
  expect(await page(2)).toContain("Nothing has happened in it for more than 7 days");
  expect(await page(2)).not.toContain(upgrade);
  expect(await page(2)).not.toContain("See plans");
  await expect(call(getConversation, team, { number: 2 })).rejects.toThrow(new OperationError(404, "not_found", "Conversation #2 is past your plan's history"));

  // On Business, the longest: nothing to upgrade to.
  await plan("business");
  expect(await page(2)).toContain("Nothing has happened in it for more than 90 days");
  expect(await page(2)).not.toContain(upgrade);
  expect(await page(2)).not.toContain("See plans");

  // A member is told who can upgrade, with no button.
  await plan(null);
  const member = await addMember(project.id, "MEMBER");
  actAs(member);
  expect(await page(1)).toContain("An owner or admin can upgrade to see it again.");
  expect(await page(1)).not.toContain("See plans");
});

test("conversations from before activeAt are dated by their updatedAt, in the Inbox's lists and in Users' counts", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const { team, conversation, listed } = await setup();
  const recent = await conversation(10, "CLOSED");
  const old = await conversation(10, "CLOSED");
  await prisma.conversation.update({ where: { id: recent.id }, data: { activeAt: null, updatedAt: daysAgo(1) } });
  await prisma.conversation.update({ where: { id: old.id }, data: { activeAt: null, updatedAt: daysAgo(10) } });
  expect(await listed()).toEqual([1]);
  expect((await call(listUsers, team, {})).users[0]!.activity.conversations).toBe(1);
  // And Closed's "past your plan's history" note counts it.
  expect(await prisma.conversation.count({ where: { projectId: team.projectId, ...pastConversations(daysAgo(7)) } })).toBe(1);
});
