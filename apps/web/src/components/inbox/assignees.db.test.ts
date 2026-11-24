import { prisma } from "@tuti/db";
import { isValidElement, type ReactElement } from "react";
import { expect, test } from "vitest";

import ConversationPage from "@/app/app/(workspace)/[project]/inbox/[number]/page";
import { listAssignees, updateConversation } from "@/server/operations/conversations";
import type { Actor } from "@/server/operations/define";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { AssignMenu } from "./conversation-controls";

// The server-rendered elements, without mounting their client components.
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(elements)];
}

test("conversations.assignees lists the teammates the conversation page's assignee picker offers, with their addresses, and which is the caller", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const tess = await addMember(project.id, "MEMBER");
  await prisma.user.update({ where: { id: tess.id }, data: { image: "https://avatars.example.com/tess.png" } });
  await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Invoices", origin: "API", email: "e2e-asker@example.com" } });

  const asUser = (userId: string) => ({ actor: { kind: "user", userId } as Actor, projectId: project.id });
  const { assignees } = await call(listAssignees, asUser(tess.id), {});
  expect(assignees).toEqual([
    { name: "Olive Owner", email: owner.email, image: null, you: false },
    { name: "member user", email: tess.email, image: "https://avatars.example.com/tess.png", you: true },
  ]);

  // The web's picker, for the same teammate: the same people, in the same order, with the same pictures, and the same one is "me".
  actAs(tess);
  const page = await ConversationPage({ params: Promise.resolve({ project: project.slug, number: "1" }), searchParams: Promise.resolve({}) });
  const menu = elements(page).find((element) => element.type === AssignMenu)!;
  const team = menu.props.team as { userId: string; name: string; image: string | null }[];
  expect(team.map(({ name, image }) => ({ name, image }))).toEqual(assignees.map(({ name, image }) => ({ name, image })));
  expect(team.find((m) => m.userId === menu.props.me)?.name).toBe(assignees.find((a) => a.you)?.name);

  // Each address assigns to that teammate; an API key's "you" is its creator.
  await call(updateConversation, asUser(owner.id), { number: 1, assignee: assignees[1]!.email });
  expect(await prisma.conversation.findFirst({ where: { projectId: project.id, number: 1 }, select: { assigneeId: true } })).toEqual({ assigneeId: tess.id });
  const key: Actor = { kind: "apiKey", keyId: "key", projectId: project.id, scope: "read", createdById: owner.id };
  expect((await call(listAssignees, { actor: key, projectId: project.id }, {})).assignees.map((a) => a.you)).toEqual([true, false]);
});
