import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { expect, test } from "vitest";

import { addMember, callerAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { createConversation, replyToConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";

/** Emails to the team about the support inbox (packages/jobs, conversation-message; jobs run inline here). */

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const member = await addMember(project.id, "MEMBER");
  const key = { actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  return { owner, project, member, key };
}

// The inbox's emails only (signing up sends a verification email too).
const to = (address: string) =>
  mailbox.emails.filter((email) => email.to.includes(address) && /conversation|replied/.test(email.subject)).map((email) => email.subject);

test("a new conversation is emailed to every team member with \"Email me new conversations\" on, which they can turn off", async () => {
  const { owner, project, member, key } = await setup();
  expect(await (await callerAs(member)).inbox.newConversationEmails({ project: project.slug, on: false })).toEqual({ on: false });

  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export is broken", body: "The button does nothing." });
  expect(to(owner.email)).toEqual(["New conversation: Export is broken"]);
  const email = await mailbox.latestTo(owner.email);
  // Named for what it's about, at the install's address.
  expect(email.from).toBe('"Tuti Inbox" <test@example.com>');
  expect(email.text).toContain("Sam started a conversation");
  expect(email.text).toContain("The button does nothing.");
  expect(email.text).toContain(`/app/${project.slug}/inbox/1`);
  expect(to(member.email)).toEqual([]);
});

test("a user's reply goes to the assignee only, at most once every 10 minutes; the team's own replies and spam tell nobody", async () => {
  const { owner, project, member, key } = await setup();
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  await call(updateConversation, key, { number: 1, assignee: member.email });
  // Told about it as new a moment ago: the next reply waits.
  await call(replyToConversation, key, { number: 1, body: "Any news?", author: { id: "user-42" } });
  expect(to(member.email)).toEqual(["New conversation: Export"]);

  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { notifiedAt: new Date(Date.now() - 11 * 60_000) } });
  await call(replyToConversation, key, { number: 1, body: "Hello?", author: { id: "user-42" } });
  expect(to(member.email)).toEqual(["New conversation: Export", "Sam replied: Export"]);
  // Assigned: the owner hears only of the new conversation.
  expect(to(owner.email)).toEqual(["New conversation: Export"]);

  // The team's reply, and anything in spam, email nobody.
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { notifiedAt: null } });
  await call(replyToConversation, key, { number: 1, body: "Looking now" });
  await call(updateConversation, key, { number: 1, spam: true });
  await call(replyToConversation, key, { number: 1, body: "Buy now", author: { id: "user-42" } });
  expect(to(member.email)).toHaveLength(2);
});

test("a reply on an unassigned conversation goes to everyone with the emails on, and someone known only by email is named by it", async () => {
  const { owner, project, member, key } = await setup();
  await call(createConversation, key, { email: "e2e-asker@example.com", subject: "Discount?", body: "Nonprofit here" });
  expect(to(owner.email)).toEqual(["New conversation: Discount?"]);
  expect(to(member.email)).toEqual(["New conversation: Discount?"]);
  expect((await mailbox.latestTo(owner.email)).text).toContain("e2e-asker@example.com started a conversation");

  // Their user's reply, with no one assigned, goes to everyone too.
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Invoices", body: "Where are they?" });
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { notifiedAt: new Date(Date.now() - 11 * 60_000) } });
  await call(replyToConversation, key, { number: 2, body: "Any news?", author: { id: "user-42" } });
  for (const address of [owner.email, member.email]) {
    expect(to(address)).toEqual(["New conversation: Discount?", "New conversation: Invoices", "Sam replied: Invoices"]);
  }
});

test("an emailed name comes with its address (anyone can give any name), and a Cc'd colleague's reply is theirs", async () => {
  const { owner, project, key } = await setup();
  const log = { info: () => {}, warn: () => {} };
  await call(createConversation, key, { email: "e2e-carlos@example.com", subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  // The name their email gave, and a reply from a colleague they Cc'd, emailed now.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { name: "Carlos Mendes", notifiedAt: null } });
  const tell = async (fromAddress: string | null) => {
    const { id } = await prisma.conversationMessage.create({
      data: { projectId: project.id, conversationId: conversation.id, author: "USER", channel: "EMAIL", body: "Never mind", fromAddress },
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: null } });
    await handlers.conversationMessage({ messageId: id }, log);
  };
  await tell("e2e-bob@example.com");
  expect(to(owner.email).at(-1)).toBe("e2e-bob@example.com replied: Export");
  await tell(null);
  expect(to(owner.email).at(-1)).toBe("Carlos Mendes (e2e-carlos@example.com) replied: Export");
});

test("one address that's refused doesn't keep the rest of the team from hearing, and only it is tried again", async () => {
  const { owner, member, key } = await setup();
  mailbox.refuseNext(member.email);
  await call(createConversation, key, { email: "e2e-asker@example.com", subject: "Refund", body: "Please" });
  // The owner heard once; the member, refused at first, heard from the retry, once.
  expect(to(owner.email)).toEqual(["New conversation: Refund"]);
  expect(to(member.email)).toEqual(["New conversation: Refund"]);
});

test("a message whose email couldn't be queued is found by the cron and emailed; told, spam or nobody to tell, it isn't", async () => {
  const { owner, project, key } = await setup();
  const log = { info: () => {}, warn: () => {} };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const resubmit = () => handlers.resubmitConversationNotices({}, log);
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: minutesAgo(30) } });
  // Told about it, then a reply saved 3 minutes ago whose email never got queued (the queue was down).
  // (Waiting since its first message, as it would be had the message been written then.)
  await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: minutesAgo(20), waitingSince: minutesAgo(30) } });
  const lost = () =>
    prisma.conversationMessage.create({
      data: { projectId: project.id, conversationId: conversation.id, author: "USER", channel: "API", body: "Hello?", createdAt: minutesAgo(3) },
    });
  await lost();

  expect(await resubmit()).toEqual({ found: 1, queued: 1 });
  expect(to(owner.email)).toEqual(["New conversation: Export", "Sam replied: Export"]);
  // Told now: nothing left.
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });

  // One inside the 10 minutes after the team was told is meant to tell nobody, so the cron leaves it too.
  await lost();
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });

  // Nor is one in spam, or one nobody on the team would hear about, found.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: minutesAgo(20), spam: true } });
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { spam: false } });
  await prisma.teamMember.updateMany({ where: { projectId: project.id }, data: { emailNewConversations: false } });
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });
  expect(to(owner.email)).toHaveLength(2);
});

test("a conversation the AI has emails nobody, at once or by the cron; taken over by a teammate's reply, the message it answered isn't emailed late", async () => {
  const { owner, project, member, key } = await setup();
  const log = { info: () => {}, warn: () => {} };
  const resubmit = () => handlers.resubmitConversationNotices({}, log);
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  mailbox.emails.length = 0;
  // Handed to the AI, long enough ago that the team could be emailed about it again.
  await call(updateConversation, key, { number: 1, handledBy: "ai" });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: null } });
  // Kept with the AI as its user writes, rather than handed over: nothing answers for the AI yet (W11).
  await prisma.workflow.create({ data: { projectId: project.id, name: "Keep", trigger: "about_to_hand_over", position: 0, actions: [{ kind: "dont_hand_over" }] } });

  await call(replyToConversation, key, { number: 1, body: "Any news?", author: { id: "user-42" } });
  expect(to(owner.email)).toEqual([]);
  expect(to(member.email)).toEqual([]);
  // Nor later: the cron that queues missed emails again leaves the AI's alone.
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });

  // A teammate's reply takes it over: what they answered isn't news to the team, so the cron still finds nothing.
  await call(replyToConversation, key, { number: 1, body: "Looking now" });
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });
  expect(to(owner.email)).toEqual([]);
  // It's the team's now: the user's next message is emailed as ever.
  await call(replyToConversation, key, { number: 1, body: "Thanks!", author: { id: "user-42" } });
  expect(to(owner.email)).toEqual(["Sam replied: Export"]);
});

test("a conversation taken over without a reply, its user still waiting: the cron emails the team about it", async () => {
  const { owner, project, key } = await setup();
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  await call(updateConversation, key, { number: 1, handledBy: "ai" });
  // Written 5 minutes ago, its user waiting since, and nobody told.
  const written = new Date(Date.now() - 5 * 60_000);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: null, waitingSince: written } });
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: written } });
  mailbox.emails.length = 0;
  const resubmit = () => handlers.resubmitConversationNotices({}, { info: () => {}, warn: () => {} });
  expect(await resubmit()).toEqual({ found: 0, queued: 0 });

  await call(updateConversation, key, { number: 1, handledBy: "team" });
  expect(await resubmit()).toEqual({ found: 1, queued: 1 });
  expect(to(owner.email)).toEqual(["New conversation: Export"]);
});

test("sample content emails nobody: the job that emails the team about a message skips a sample conversation's", async () => {
  const { owner, project, key } = await setup();
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, author: "USER" } });
  // As Home's "Add sample content" leaves one, and not told about yet: the team would be emailed were it real.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { sample: true, notifiedAt: null } });
  mailbox.emails.length = 0;

  expect(await handlers.conversationMessage({ messageId: message.id }, { info: () => {}, warn: () => {} })).toEqual({ skipped: "nothing to tell" });
  expect(to(owner.email)).toEqual([]);
});

test("a message the teammate's reply didn't see is still found by the cron: the reply answered what came before it, not that one", async () => {
  const { owner, project, key } = await setup();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export", body: "Hi" });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  // The first message, half an hour ago, which the team was told about.
  await prisma.conversationMessage.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: minutesAgo(30) } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { notifiedAt: minutesAgo(20), waitingSince: minutesAgo(30) } });
  // Another, 3 minutes ago, whose email never got queued (the queue was down)...
  await prisma.conversationMessage.create({
    data: { projectId: project.id, conversationId: conversation.id, author: "USER", channel: "API", body: "Also, the export is empty", createdAt: minutesAgo(3) },
  });
  // ...and a teammate's reply to what they'd seen a minute before it: the conversation stays open, waiting on the team.
  await call(replyToConversation, key, { number: 1, body: "Hi Sam, looking now", seen: minutesAgo(4).toISOString() });
  expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ status: "OPEN" });
  mailbox.emails.length = 0;

  expect(await handlers.resubmitConversationNotices({}, { info: () => {}, warn: () => {} })).toEqual({ found: 1, queued: 1 });
  expect(to(owner.email)).toEqual(["Sam replied: Export"]);
});
