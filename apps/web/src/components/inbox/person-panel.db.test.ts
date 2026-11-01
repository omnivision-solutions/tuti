import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { userAccounts } from "@/server/operations/users";
import { upsertProjectUser } from "@/server/project-users";
import { createProject, signUp } from "@/test/helpers";

import { maybeUser, PersonPanel } from "./person-panel";

test("the hint finds the project's user whatever the capitals in their saved address, and only in that project", async () => {
  const project = await createProject(await signUp());
  const userId = await upsertProjectUser(project.id, "kim-1", { name: "Kim Lee" });
  // As an older instance may have saved it.
  await prisma.ssoIdentity.update({ where: { userId }, data: { email: "E2E-Kim@Example.com" } });
  expect(await maybeUser(project.id, "e2e-kim@example.com")).toEqual({ name: "Kim Lee", id: "kim-1" });
  const other = await createProject(await signUp());
  expect(await maybeUser(other.id, "e2e-kim@example.com")).toBeNull();
});

test("a user's page lists what they did with every account that is them, as Users counts it; not spam", async () => {
  const project = await createProject(await signUp());
  const userId = await upsertProjectUser(project.id, "bea-2", { name: "Bea Byte", email: "e2e-bea@example.com" });
  // Signed in to the portal another way, with the address verified (in capitals, as older accounts kept it).
  const portal = await prisma.user.create({ data: { id: crypto.randomUUID(), name: "Bea", email: "E2E-Bea@example.com", emailVerified: true } });
  const board = project.boards[0]!;
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: (await signUp()).id, number: 1, title: "Dark mode" } });
  await prisma.vote.create({ data: { projectId: project.id, postId: post.id, userId: portal.id } });
  // An email from the address, and one marked as spam.
  for (const [number, spam] of [[1, false], [2, true]] as const) {
    await prisma.conversation.create({
      data: { projectId: project.id, number, subject: spam ? "Cheap pills" : "Invoices", origin: "EMAIL", email: "e2e-bea@example.com", emailVerified: true, spam },
    });
  }
  const accounts = await userAccounts(project.id, { userId, email: "e2e-bea@example.com" });
  expect(accounts.sort()).toEqual([userId, portal.id].sort());
  const html = renderToStaticMarkup(
    await PersonPanel({ projectId: project.id, slug: project.slug, person: { userId, email: "e2e-bea@example.com", emailVerified: true, accounts } }),
  );
  expect(html).toContain("Dark mode");
  expect(html).toContain("Invoices");
  expect(html).not.toContain("Cheap pills");
});
