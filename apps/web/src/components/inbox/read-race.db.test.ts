import { prisma } from "@tuti/db";
import { isValidElement, type ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import ConversationPage from "@/app/app/[project]/inbox/[number]/page";
import * as reads from "@/server/conversation-reads";
import { actAs, createProject, signUp } from "@/test/helpers";

import { InboxPanes } from "./inbox-panes";
import { MarkRead } from "./mark-read";

const loadReads = reads.conversationReads;
afterEach(() => vi.restoreAllMocks());

// Inspect the server-rendered elements without mounting their client components.
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(elements)];
}

test.each(["list", "page"] as const)("the %s treats a conversation deleted before loading read state as read", async (screen) => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const conversation = await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Exporting reports", email: "e2e-sam@example.com", origin: "API", sample: true } });
  const loading = vi.spyOn(reads, "conversationReads").mockImplementationOnce(async (ids, userId) => {
    // Sample content can be removed after the conversation query, before the batched read query joins it.
    await prisma.conversation.delete({ where: { id: conversation.id } });
    return loadReads(ids, userId);
  });
  const tree = screen === "list"
    ? await InboxPanes({ slug: project.slug, view: "open", open: 1 })
    : await ConversationPage({ params: Promise.resolve({ project: project.slug, number: "1" }), searchParams: Promise.resolve({}) });
  expect(loading).toHaveBeenCalledWith([conversation.id], owner.id);
  expect(await prisma.conversation.count({ where: { id: conversation.id } })).toBe(0);
  if (screen === "list") {
    const row = elements(tree).find((element) => element.props["data-row-link"] === 1);
    expect(row?.props["aria-label"]).not.toMatch(/unread/i);
    expect(row?.props.className).toContain("font-normal");
  } else {
    const acknowledgement = elements(tree).find((element) => element.type === MarkRead);
    expect(acknowledgement?.props.unread).toBe(false);
  }
});
