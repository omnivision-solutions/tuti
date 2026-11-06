import { prisma } from "@tuti/db";
import { handlers, IMPORT_KEY, importsSettled } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { FAKE_FEATUREBASE_FILES, FAKE_FEATUREBASE_KEY, type FeaturebaseFake, featurebaseFixtures, type S3Fake, startFeaturebaseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { widgetToken } from "@/lib/widget-session";
import { startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain } from "./inbound";
import { widgetConversation } from "./widget-inbox";
import { unseenRepliesOf } from "./widget-person";

/** The inbox from Featurebase (docs/plan.md, Switching from Featurebase, I5), against the Featurebase and S3 fakes. */

const log = { info: () => {}, warn: () => {} };
/** The fake's key as an import's row keeps it (sealed). */
const sealedKey = () => sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY);
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

test("conversations still going and the closed ones Tuti keeps come across, numbered in Featurebase's order, with their status, people and messages; nothing is emailed", async () => {
  const emailed = mailbox.emails.length;
  const done = await importInbox();
  expect(done).toMatchObject({
    state: "DONE",
    // The one closed two years ago would be deleted by the daily history job: counted, not imported.
    counts: { contacts: { imported: 3 }, conversations: { imported: 3, leftOut: { "closed more than 365 days ago, past what Tuti keeps": 1 } }, attachments: { imported: 1, leftOut: {} } },
  });

  const [open, snoozed, closed, ...rest] = await conversations();
  expect(rest).toEqual([]);
  // Numbered as they're saved, in Featurebase's order: the newest first.
  expect([open, snoozed, closed].map((c) => [c!.number, c!.subject])).toEqual([
    [1, "Exporting to CSV"],
    [2, "Invoice for October"],
    // No title or email subject: the first message's start.
    [3, "How do I reset my password?"],
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
    [1, "Exporting to CSV", "OPEN"],
    [2, "Invoice for October", "WAITING"],
    [3, "How do I reset my password?", "CLOSED"],
    [4, "Dark mode?", "CLOSED"],
  ]);
});

test("a page run again, or another import, brings nothing twice; a number once given never changes, an older one brought later getting the next", async () => {
  fake.pageSize = 2;
  const done = await importInbox();
  const before = await conversations();
  // As if its last save had been lost: the conversations step again from the start.
  await prisma.dataImport.update({ where: { id: done.id }, data: { state: "RUNNING", apiKey: sealedKey(), step: "conversations", cursor: null, counts: done.counts! } });
  await handlers.importStep({ importId: done.id }, log);
  await importsSettled();
  // Someone writes in, then the import runs again with a conversation that started before that.
  const { conversationCount } = await prisma.project.update({ where: { id: project.id }, data: { conversationCount: { increment: 1 } } });
  await prisma.conversation.create({ data: { projectId: project.id, number: conversationCount, subject: "New here", origin: "API" } });
  fake.fixtures.conversations.push({ ...fake.fixtures.conversations[2]!, id: "0999", title: "Older still", createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
  await importInbox();

  const after = await conversations();
  // The team may know them by their numbers by now (a link in an email, a note): they stay.
  expect(after.map((c) => [c.number, c.subject])).toEqual([
    [1, "Exporting to CSV"],
    [2, "Invoice for October"],
    [3, "How do I reset my password?"],
    [4, "New here"],
    [5, "Older still"],
  ]);
  expect(after.flatMap((c) => c.messages)).toHaveLength(before.flatMap((c) => c.messages).length + 2);
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(1);
});

test("imported again, a conversation that changed in Featurebase gets its new messages, waiting for a reply again; one that didn't isn't read again", async () => {
  await importInbox();
  const before = await conversations();
  const emailed = mailbox.emails.length;
  // Tobias writes again on his snoozed invoice conversation, in Featurebase.
  const invoice = fake.fixtures.conversations.find((c) => c.id === "1003")!;
  const wrote = new Date(Date.now() - 86_400_000).toISOString();
  Object.assign(invoice, { state: "open", snoozedUntil: null, lastActivityAt: wrote, updatedAt: wrote });
  (invoice.conversationParts as object[]).push({
    object: "conversation_part",
    id: "p2004",
    partType: "email_msg",
    createdAt: wrote,
    updatedAt: wrote,
    bodyHtml: "<p>Still not here, sorry.</p>",
    channel: "email",
    author: { id: "65f000000000000000000002", type: "customer", name: "Tobias Quill", email: "e2e-tobias@example.com", profilePicture: null },
  });
  fake.requests.length = 0;
  const again = await importInbox();

  expect(fake.requests.filter((r) => /\/conversations\/\w+/.test(r))).toEqual(["GET /v2/conversations/1003"]);
  expect(again.counts).toMatchObject({ messages: { imported: 1 }, conversations: { imported: 0, leftOut: { "already brought across earlier": 3 } } });
  const after = await conversations();
  expect(after.map((c) => [c.number, c.subject, c.messages.length])).toEqual(before.map((c) => [c.number, c.subject, c.messages.length + (c.subject === "Invoice for October" ? 1 : 0)]));
  expect(after.find((c) => c.subject === "Invoice for October")).toMatchObject({
    status: "OPEN",
    waitingSince: new Date(wrote),
    lastMessageAt: new Date(wrote),
    snoozedUntil: null,
    messages: expect.arrayContaining([expect.objectContaining({ body: "Still not here, sorry.", author: "USER", authorUser: { name: "Tobias Quill" } })]),
  });
  expect(mailbox.emails.length).toBe(emailed);

  // And again, with nothing new: nothing read, nothing added.
  fake.requests.length = 0;
  await importInbox();
  expect(fake.requests.filter((r) => /\/conversations\/\w+/.test(r))).toEqual([]);
  expect((await conversations()).flatMap((c) => c.messages)).toHaveLength(after.flatMap((c) => c.messages).length);
});

test("an import that fails partway and is started again goes on numbering where it stopped, each conversation once", async () => {
  fake.pageSize = 1;
  // Featurebase refuses the second conversation once: the import fails there, the first saved.
  const fetch = globalThis.fetch.bind(globalThis);
  let refused = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input).includes("/v2/conversations/1003") && refused++ === 0 ? Promise.resolve(Response.json({ message: "Not now" }, { status: 400 })) : fetch(input, init),
  );
  expect(await importInbox()).toMatchObject({ state: "FAILED" });
  expect((await conversations()).map((c) => [c.number, c.subject])).toEqual([[1, "Exporting to CSV"]]);

  // Started again, as the failure says: the rest come after, nothing twice, nothing renumbered.
  expect(await importInbox()).toMatchObject({ state: "DONE" });
  expect((await conversations()).map((c) => [c.number, c.subject, c.messages.length])).toEqual([
    [1, "Exporting to CSV", 4],
    [2, "Invoice for October", 2],
    [3, "How do I reset my password?", 2],
  ]);
});

test("a subject is never taken from an internal note: the user sees it, in the widget and their emails", async () => {
  // The team started it with a note, then wrote to them; no title, no email subject.
  const closed = fake.fixtures.conversations[2]!;
  const parts = closed.conversationParts as Record<string, unknown>[];
  parts.unshift({ ...parts[1], id: "p3000", partType: "admin_note", createdAt: new Date(Date.parse(String(parts[0]!.createdAt)) - 60_000).toISOString(), bodyHtml: "<p>Owes us three invoices</p>", author: { id: "65f0000000000000000000a1", type: "admin" } });
  await importInbox();
  expect((await conversations()).find((c) => c.messages.some((m) => m.note && m.body === "Owes us three invoices"))!.subject).toBe("How do I reset my password?");
});

test("the team is never told of imported history: the cron that resends the team's missed notices finds none", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  // The user's last message an hour ago, unanswered, in a conversation assigned to the owner: inside the cron's window.
  (fake.fixtures.conversations[0]!.conversationParts as { createdAt: string }[])[4]!.createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
  await importInbox();
  const emailed = mailbox.emails.length;
  expect(await handlers.resubmitConversationNotices({}, log)).toEqual({ found: 0, queued: 0 });
  expect(mailbox.emails.length).toBe(emailed);
});

test("a snooze's time is its latest snooze, whatever order Featurebase sends the parts in", async () => {
  const snoozed = fake.fixtures.conversations[1]!;
  const parts = snoozed.conversationParts as { id: string; createdAt: string }[];
  const [asked, replied, latest] = parts;
  // Snoozed once before the reply too; sent newest first, the earlier snooze last.
  const earlier = { ...latest!, id: "p2000", createdAt: new Date(Date.parse(asked!.createdAt) + 10 * 60_000).toISOString() };
  snoozed.conversationParts = [latest, replied, asked, earlier];
  await importInbox();
  const conversation = (await conversations()).find((c) => c.subject === "Invoice for October")!;
  expect(conversation.messages.map((m) => m.author)).toEqual(["USER", "TEAM"]);
  expect(conversation.snoozedAt).toEqual(new Date(latest!.createdAt));
});

test("an image-only message whose image can't be brought keeps saying it had one, whatever the reason", async () => {
  // The user's last message is just an image Featurebase no longer has.
  (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[4]!.bodyHtml = `<p><img src="${FAKE_FEATUREBASE_FILES}gone.png?X-Amz-Signature=abc"></p>`;
  const done = await importInbox();
  expect(done.counts).toMatchObject({ attachments: { imported: 0, leftOut: { "that couldn't be fetched": 1 } } });
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.status).toBe("OPEN");
  expect(open.messages.at(-1)).toMatchObject({ author: "USER", body: "", attachmentsDropped: 1 });
});

test("a conversation Featurebase cut to its newest 500 parts is counted, its start from its source; one sent in full isn't, its start once", async () => {
  const conversation = fake.fixtures.conversations[2]!;
  const [question] = conversation.conversationParts as { createdAt: string }[];
  const tags = (from: number) => Array.from({ length: 499 }, (_, i) => ({ object: "conversation_part", id: `t${i}`, partType: "tags", createdAt: new Date(from + (i + 1) * 1000).toISOString() }));
  const cut = "whose messages before their newest 500 are missing: Featurebase gives no more";
  const start = Date.parse(question!.createdAt);
  const messages = async () => (await conversations()).find((c) => c.subject === "How do I reset my password?")!.messages.map((m) => [m.author, m.body]);

  // All of it: the question, then 499 tag changes. Exactly 500 parts, nothing missing.
  conversation.conversationParts = [question, ...tags(start)];
  const full = await importInbox();
  expect(full.counts).toMatchObject({ conversations: { leftOut: expect.not.objectContaining({ [cut]: expect.anything() }) } });
  expect(await messages()).toEqual([["USER", "How do I reset my password?\nIt says the link expired."]]);

  // The newest 500, an hour on: the question isn't among them, so it comes from the conversation's source.
  await prisma.conversation.deleteMany({ where: { projectId: project.id } });
  await prisma.importedRecord.deleteMany({ where: { projectId: project.id, kind: "conversation" } });
  conversation.conversationParts = [...tags(start + 60 * 60_000), { object: "conversation_part", id: "t499", partType: "tags", createdAt: new Date(start + 2 * 60 * 60_000).toISOString() }];
  const cutShort = await importInbox();
  expect(cutShort.counts).toMatchObject({ conversations: { leftOut: { [cut]: 1 } } });
  expect(await messages()).toEqual([["USER", "How do I reset my password?\nIt says the link expired."]]);
});

test("a link with bold words in it gets its address once, after all its words", async () => {
  (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[2]!.bodyHtml = '<p>See <a href="https://docs.example.com/export">the <strong>export</strong> guide</a>.</p>';
  await importInbox();
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.messages[1]!.body).toBe("See the export guide (https://docs.example.com/export).");
});

test("a part too long to be content keeps its text (cut as a received email's is) and its Featurebase files: the user's last message, it still needs a reply", async () => {
  const last = (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string; bodyMarkdown?: string }[])[4]!;
  // Junk entities too (one past Unicode's last code point), as pasted mail has.
  last.bodyHtml = `<p>Fish &amp; chips &#99999999; &#x110000;</p><p>${"word ".repeat(50_000).trim()}</p><p><img src="${FAKE_FEATUREBASE_FILES}shot.png?X-Amz-Expires=3600&amp;X-Amz-Signature=abc"></p>`;
  delete last.bodyMarkdown;
  await importInbox();
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.status).toBe("OPEN");
  const message = open.messages.at(-1)!;
  expect([message.author, message.body.split("\n")[1]!.slice(0, 9), message.body.length, message.attachments.length]).toEqual(["USER", "word word", 10_000, 1]);
  expect(message.body).toMatch(/^Fish & chips /);
});

test("only files in Featurebase's storage come across: another site's image isn't fetched, as inbound email leaves remote images", async () => {
  // The team's reply links an image on another site (here, the fake under another host name).
  const reply = (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[2]!;
  const outside = `${fake.url.replace("127.0.0.1", "localhost")}/files/shot.png`;
  reply.bodyHtml += `<p><img src="${outside}" alt="Their chart"></p>`;
  await importInbox();
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  // The reply has words of its own: the image's alt text only, not its address (a signature's logos and pixels would be links).
  expect(open.messages[1]).toMatchObject({ body: expect.stringContaining("Their chart"), attachments: [], attachmentsDropped: 0 });
  expect(open.messages[1]!.body).not.toContain(outside);
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(1);
});

test("a message that was only another site's image stays, its address as its text: who wrote last decides the status", async () => {
  (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[4]!.bodyHtml = '<p><img src="https://images.example.com/screen.png"></p>';
  await importInbox();
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.status).toBe("OPEN");
  expect(open.messages.at(-1)).toMatchObject({ author: "USER", body: "https://images.example.com/screen.png", attachments: [], attachmentsDropped: 0 });
});

test("a video with no source is nothing to bring: a message of only that is left out, not kept blank", async () => {
  const parts = fake.fixtures.conversations[0]!.conversationParts as Record<string, unknown>[];
  parts.push({ ...parts[4], id: "p1006", createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), bodyHtml: "<video controls></video>" });
  const done = await importInbox();
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.messages).toHaveLength(4);
  expect(open.messages.every((m) => m.body !== "" && m.attachmentsDropped === 0)).toBe(true);
  expect(done.counts).toMatchObject({ attachments: { imported: 1, leftOut: {} } });
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
  (fake.fixtures.conversations[0]!.conversationParts as { bodyHtml: string }[])[4]!.bodyHtml = `<p><img src="${FAKE_FEATUREBASE_FILES}shot.png?X-Amz-Signature=abc"></p>`;
  const done = await importInbox();
  expect(done.counts).toMatchObject({ attachments: { imported: 0, leftOut: { "as this server has no media storage": 1 } } });
  expect(await prisma.conversationAttachment.count({ where: { projectId: project.id } })).toBe(0);
  // They wrote last: it still needs a reply.
  const open = (await conversations()).find((c) => c.subject === "Exporting to CSV")!;
  expect(open.status).toBe("OPEN");
  expect(open.messages.at(-1)).toMatchObject({ author: "USER", body: "", attachmentsDropped: 1 });

  // In their widget too, it says it had an attachment, never an empty bubble.
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const mira = await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "app-user-1" }, select: { userId: true } });
  const shown = (await widgetConversation(project.slug, { token: widgetToken(project.id, mira.userId) }, open.number)) as { messages: { body: string; dropped: number }[] };
  expect(shown.messages.at(-1)).toMatchObject({ body: "", dropped: 1 });
});

/** An import's row at the conversations step, as if Contacts had been picked and skipped over. */
const atConversations = (parts = ["contacts", "inbox"]) =>
  prisma.dataImport.create({ data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealedKey(), parts, step: "conversations" } });

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
