import { prisma } from "@tuti/db";
import { handlers, importsSettled } from "@tuti/jobs";
import { FAKE_FEATUREBASE_FILES, FAKE_FEATUREBASE_KEY, type FeaturebaseFake, featurebaseFixtures, type S3Fake, startFeaturebaseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain } from "./inbound";
import { unseenRepliesOf } from "./widget-person";

/** The inbox from Featurebase (docs/plan.md, Switching from Featurebase, I5), against the Featurebase and S3 fakes. */

const log = { info: () => {}, warn: () => {} };
let fake: FeaturebaseFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startFeaturebaseFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  vi.stubEnv("FEATUREBASE_API_URL", fake.url);
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  vi.stubEnv("PLANS", "on");
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  Object.assign(fake, { fixtures: featurebaseFixtures(), pageSize: 100 });
  fake.forbidden.clear();
  fake.requests.length = 0;
  owner = await signUp("Olive Owner");
  // The fixtures' owner is this team member, by their verified address; the former admin isn't on the team.
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  fake.fixtures.admins[0]!.email = owner.email;
  project = await createProject(owner);
  actAs(owner);
});

const importInbox = async () => {
  const started = await call(startImport, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts", "inbox"] });
  await importsSettled();
  return prisma.dataImport.findUniqueOrThrow({ where: { id: started.id } });
};
const conversations = () =>
  prisma.conversation.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    include: {
      user: { select: { name: true } },
      assignee: { select: { name: true } },
      heldBy: { select: { name: true, placeholderProjectId: true } },
      messages: { orderBy: { createdAt: "asc" }, include: { authorUser: { select: { name: true } }, attachments: true } },
    },
  });
const ago = (date: Date | null) => date && Math.round((Date.now() - date.getTime()) / 86_400_000);

test("conversations still going and the closed ones Tuti keeps come across, in date order, with their status, people and messages; nothing is emailed", async () => {
  const emailed = mailbox.emails.length;
  const done = await importInbox();
  expect(done).toMatchObject({
    state: "DONE",
    // The one closed two years ago would be deleted by the daily history job: counted, not imported.
    counts: { contacts: { imported: 3 }, conversations: { imported: 3, leftOut: { "closed more than 365 days ago, past what Tuti keeps": 1 } }, attachments: { imported: 1, leftOut: {} } },
  });

  const [closed, snoozed, open, ...rest] = await conversations();
  expect(rest).toEqual([]);
  // Numbered in the order they started, though Featurebase lists the newest first.
  expect([closed, snoozed, open].map((c) => [c!.number, c!.subject])).toEqual([
    // No title or email subject: the first message's start.
    [1, "How do I reset my password?"],
    [2, "Invoice for October"],
    [3, "Exporting to CSV"],
  ]);

  // Closed with the bot: the person's message and the bot's answer; quick replies, ratings, workflows, attributes,
  // priority, participants, tags and status changes aren't messages.
  expect(closed).toMatchObject({ status: "CLOSED", origin: "WIDGET", user: { name: "Juno Park" }, assigneeId: null, heldById: null, waitingSince: null, snoozedUntil: null });
  expect(ago(closed!.createdAt)).toBe(10);
  expect(ago(closed!.activeAt)).toBe(10);
  expect(closed!.messages.map((m) => [m.author, m.authorUser?.name ?? null, m.body])).toEqual([
    ["USER", "Juno Park", "How do I reset my password?\nIt says the link expired."],
    ["AI", null, "Use Forgot password on the sign-in page:\n1. Open sign in\n2. Ask for a new link"],
  ]);

  // Snoozed after the team's reply by email: waiting on the user, held by the former admin's placeholder (unassigned).
  expect(snoozed).toMatchObject({ status: "WAITING", origin: "EMAIL", user: { name: "Tobias Quill" }, assigneeId: null, heldBy: { name: "Fern Former", placeholderProjectId: project.id }, waitingSince: null });
  expect(ago(snoozed!.snoozedUntil)).toBe(-7);
  expect(snoozed!.snoozedAt!.getTime()).toBe(snoozed!.messages[1]!.createdAt.getTime() + 60_000);
  expect(snoozed!.messages.map((m) => [m.author, m.authorUser?.name, m.channel, m.seenAt])).toEqual([
    ["USER", "Tobias Quill", "EMAIL", null],
    // Their read receipt is before it: not seen.
    ["TEAM", "Fern Former", "EMAIL", null],
  ]);

  // Open, the user writing last; assigned to the owner. The first part repeats the conversation's start: once.
  expect(open).toMatchObject({ status: "OPEN", origin: "WIDGET", user: { name: "Mira Fenwick" }, assignee: { name: "Olive Owner" }, heldById: null, snoozedUntil: null });
  expect(open!.waitingSince).toEqual(open!.messages[3]!.createdAt);
  expect(open!.lastMessageAt).toEqual(open!.messages[3]!.createdAt);
  expect(open!.messages.map((m) => [m.author, m.note, m.authorUser?.name, m.body])).toEqual([
    ["USER", false, "Mira Fenwick", "Can I export my data to CSV?"],
    ["TEAM", false, "Olive Owner", "Yes: Settings → Export. See the guide (https://docs.example.com/export)."],
    ["TEAM", true, "Olive Owner", "They're on the pro plan."],
    ["USER", false, "Mira Fenwick", "Here's what I see:\n\nExport screen"],
  ]);
  // Read up to the team's reply: seen then, as Featurebase's read receipt says.
  expect(open!.messages[1]!.seenAt).toEqual(open!.messages[1]!.createdAt);
  // The image came as an attachment, stored.
  const [shot] = open!.messages[3]!.attachments;
  expect(shot).toMatchObject({ filename: "shot.png", contentType: "image/png", size: s3.objects.get(shot!.key)!.body.byteLength });

  // Every message is marked as imported, at its original date; the team's with their email tries used up.
  const messages = [closed, snoozed, open].flatMap((c) => c!.messages);
  expect(messages.every((m) => m.importId === done.id)).toBe(true);
  expect(messages.filter((m) => m.author === "TEAM").every((m) => m.emailAttempts === 3 && m.emailStatus === null)).toBe(true);
  expect(ago(messages[0]!.createdAt)).toBe(10);
  expect(mailbox.emails.length).toBe(emailed);
});

test("without plans, every closed conversation comes across: none is deleted", async () => {
  vi.stubEnv("PLANS", "");
  const done = await importInbox();
  expect(done.counts).toMatchObject({ conversations: { imported: 4, leftOut: {} } });
  expect((await conversations()).map((c) => [c.number, c.subject, c.status])).toEqual([
    [1, "Dark mode?", "CLOSED"],
    [2, "How do I reset my password?", "CLOSED"],
    [3, "Invoice for October", "WAITING"],
    [4, "Exporting to CSV", "OPEN"],
  ]);
});

test("a page run again, or another import, brings nothing twice; an import numbers what it brought in date order, leaving every number given before", async () => {
  fake.pageSize = 2;
  const done = await importInbox();
  const before = await conversations();
  // As if its last save had been lost: the conversations step again from the start.
  await prisma.dataImport.update({ where: { id: done.id }, data: { state: "RUNNING", apiKey: FAKE_FEATUREBASE_KEY, step: "conversations", cursor: null, counts: done.counts! } });
  await handlers.importStep({ importId: done.id }, log);
  await importsSettled();
  // Someone writes in, then the import runs again with a conversation that started before that.
  const { conversationCount } = await prisma.project.update({ where: { id: project.id }, data: { conversationCount: { increment: 1 } } });
  await prisma.conversation.create({ data: { projectId: project.id, number: conversationCount, subject: "New here", origin: "API" } });
  fake.fixtures.conversations.push({ ...fake.fixtures.conversations[2]!, id: "0999", title: "Older still", createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
  await importInbox();

  const after = await conversations();
  // The team may know the first import's by their numbers by now: they stay, and so does the one started meanwhile.
  expect(after.map((c) => [c.number, c.subject])).toEqual([
    [1, "How do I reset my password?"],
    [2, "Invoice for October"],
    [3, "Exporting to CSV"],
    [4, "New here"],
    [5, "Older still"],
  ]);
  expect(after.flatMap((c) => c.messages)).toHaveLength(before.flatMap((c) => c.messages).length + 2);
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(1);
});

test("imported replies are never emailed, also by a worker from before imports were marked, and make no unread dot; seen only where Featurebase says so", async () => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  await mailSubdomain(project.id);
  await importInbox();
  const emailed = mailbox.emails.length;
  const reply = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM", note: false, seenAt: null } });

  const importId = reply.importId!;
  // A worker from before importId doesn't know the mark (as if it weren't there): the tries the import used up skip it.
  await prisma.conversationMessage.update({ where: { id: reply.id }, data: { importId: null } });
  await handlers.sendConversationReplies({}, log);
  expect(mailbox.emails.length).toBe(emailed);
  // Marked as imported: skipped, whatever its tries.
  await prisma.conversationMessage.update({ where: { id: reply.id }, data: { importId, emailAttempts: 0 } });
  await handlers.sendConversationReplies({}, log);
  expect(mailbox.emails.length).toBe(emailed);
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ emailStatus: null, emailClaimedAt: null });

  // No dot for history: the unread reply is imported, the other one read.
  const [mira, tobias] = await Promise.all(
    ["app-user-1", "app-user-2"].map((externalId) => prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId }, select: { userId: true } })),
  );
  expect(await unseenRepliesOf(project.id, tobias!.userId)).toBe(0);
  expect(await unseenRepliesOf(project.id, mira!.userId)).toBe(0);
});

test("without media storage, an image is left out of its message and counted; a message that was only the image stays, saying so", async () => {
  for (const name of Object.keys(s3.env)) {
    vi.stubEnv(name, "");
  }
  // The user's last message is just a screenshot, with no alt text.
  (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[4]!.bodyHtml = `<p><img src="${FAKE_FEATUREBASE_FILES}/shot.png?X-Amz-Signature=abc"></p>`;
  const done = await importInbox();
  expect(done.counts).toMatchObject({ attachments: { imported: 0, leftOut: { "as this server has no media storage": 1 } } });
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(0);
  // They wrote last: it still needs a reply.
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.status).toBe("OPEN");
  expect(open.messages.at(-1)).toMatchObject({ author: "USER", body: "", attachmentsDropped: 1 });
});

/** An import's row at the conversations step, as if Contacts had been picked and skipped over. */
const atConversations = (parts = ["contacts", "inbox"]) =>
  prisma.dataImport.create({ data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: FAKE_FEATUREBASE_KEY, parts, step: "conversations" } });

test("a page that fails after copying its files leaves them unattached, for the daily cleanup", async () => {
  // Its contacts aren't here yet, and Featurebase refuses them once the conversations (and their files) are read.
  fake.forbidden.add("/v2/contacts");
  const row = await atConversations();
  expect(await handlers.importStep({ importId: row.id }, log)).toEqual({ failed: true });
  const files = await prisma.conversationAttachment.findMany({ where: { projectId: project.id } });
  expect(files).toEqual([expect.objectContaining({ messageId: null, filename: "shot.png" })]);
  expect(s3.objects.has(files[0]!.key)).toBe(true);
  expect(await prisma.conversation.count({ where: { projectId: project.id } })).toBe(0);
});

test("a page that has read for a while saves what it read and reads its list page again, counting each conversation once; files it has no time left for are left out", async () => {
  // Over two minutes pass once the first conversation has been read, before its files are copied.
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + (fake.requests.some((r) => r.startsWith("GET /v2/conversations/")) ? 130_000 : 0));
  const done = await importInbox();
  expect(done.counts).toMatchObject({
    conversations: { imported: 3, leftOut: { "closed more than 365 days ago, past what Tuti keeps": 1 } },
    attachments: { imported: 0, leftOut: { "that the page had no time left to copy": 1 } },
  });
  expect(fake.requests.filter((r) => r.startsWith("GET /v2/conversations?")).length).toBe(3);
  expect((await conversations()).map((c) => c.number)).toEqual([1, 2, 3]);
});
