import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { addMember, actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { setNewConversationEmails } from "./inbox";
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
  actAs(member);
  expect(await setNewConversationEmails(project.slug, false)).toEqual({});

  await call(createConversation, key, { user: { id: "user-42", name: "Sam" }, subject: "Export is broken", body: "The button does nothing." });
  expect(to(owner.email)).toEqual(["New conversation: Export is broken"]);
  const email = await mailbox.latestTo(owner.email);
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
  const { owner, member, key } = await setup();
  await call(createConversation, key, { email: "e2e-asker@example.com", subject: "Discount?", body: "Nonprofit here" });
  expect(to(owner.email)).toEqual(["New conversation: Discount?"]);
  expect(to(member.email)).toEqual(["New conversation: Discount?"]);
  expect((await mailbox.latestTo(owner.email)).text).toContain("e2e-asker@example.com started a conversation");
});

test("one address that's refused doesn't keep the rest of the team from hearing, and only it is tried again", async () => {
  const { owner, member, key } = await setup();
  mailbox.refuseNext(member.email);
  await call(createConversation, key, { email: "e2e-asker@example.com", subject: "Refund", body: "Please" });
  // The owner heard once; the member, refused at first, heard from the retry, once.
  expect(to(owner.email)).toEqual(["New conversation: Refund"]);
  expect(to(member.email)).toEqual(["New conversation: Refund"]);
});
