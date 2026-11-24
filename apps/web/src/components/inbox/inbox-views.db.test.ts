import { prisma } from "@tuti/db";
import { isValidElement, type ReactElement } from "react";
import { expect, test } from "vitest";

import { SectionLink } from "@/components/pane";
import { listConversations, listInboxViews } from "@/server/operations/conversations";
import type { Actor } from "@/server/operations/define";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { InboxPanes } from "./inbox-panes";

// The server-rendered elements, without mounting their client components.
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(elements)];
}

test("conversations.views counts each view as the web Inbox's section does, and conversations.list's `view` lists those conversations", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const tess = await addMember(project.id, "MEMBER");
  const [soon, before] = [new Date(Date.now() + 3_600_000), new Date(Date.now() - 3_600_000)];
  const conversations = [
    {},
    { assigneeId: owner.id },
    { assigneeId: tess.id },
    { status: "WAITING", assigneeId: owner.id },
    { assigneeId: owner.id, snoozedUntil: soon },
    { status: "CLOSED", assigneeId: owner.id },
    { spam: true },
    // A snooze left on a closed one: closed, not snoozed. One whose time has passed: back in the views.
    { status: "CLOSED", snoozedUntil: soon },
    { snoozedUntil: before },
  ] as const;
  for (const [i, data] of conversations.entries()) {
    await prisma.conversation.create({ data: { projectId: project.id, number: i + 1, subject: `Conversation ${i + 1}`, origin: "API", email: `e2e-${i + 1}@example.com`, ...data } });
  }
  const olive = { open: [1, 2, 3, 9], mine: [2, 4], unassigned: [1, 9], waiting: [4], snoozed: [5], closed: [6, 8], spam: [7] };

  const asUser = (userId: string) => ({ actor: { kind: "user", userId } as Actor, projectId: project.id });
  const { views } = await call(listInboxViews, asUser(owner.id), {});
  expect(views.map(({ view, count }) => [view, count])).toEqual(Object.entries(olive).map(([view, numbers]) => [view, numbers.length]));

  // The web Inbox's own numbers, for the same teammate: the same names in the same order, with the same counts.
  actAs(owner);
  const sections = elements(await InboxPanes({ slug: project.slug, view: "open", open: 1 })).filter((element) => element.type === SectionLink);
  expect(sections.map((section) => [section.props.children, section.props.count])).toEqual(views.map(({ title, count }) => [title, count]));

  // Each view's list is those conversations, and its total the view's count.
  for (const { view, count } of views) {
    const listed = await call(listConversations, asUser(owner.id), { view });
    expect(listed.conversations.map((c) => c.number).sort(), view).toEqual(olive[view]);
    expect(listed.total).toBe(count);
  }
  // A view narrows with the other filters, and decides spam by itself.
  expect((await call(listConversations, asUser(owner.id), { view: "open", assignee: "none" })).conversations.map((c) => c.number).sort()).toEqual([1, 9]);
  expect((await call(listConversations, asUser(owner.id), { view: "spam", spam: "false" })).total).toBe(1);

  // Mine is whoever asks: another teammate's own, and for an API key its creator's.
  const mine = async (actor: Actor) => (await call(listConversations, { actor, projectId: project.id }, { view: "mine" })).conversations.map((c) => c.number).sort();
  expect(await mine({ kind: "user", userId: tess.id })).toEqual([3]);
  expect((await call(listInboxViews, asUser(tess.id), {})).views.find(({ view }) => view === "mine")?.count).toBe(1);
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "read", createdById: owner.id };
  expect(await mine(key)).toEqual(olive.mine);
  expect((await call(listInboxViews, { actor: key, projectId: project.id }, {})).views).toEqual(views);
});
