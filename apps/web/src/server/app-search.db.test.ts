import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { searchApp } from "./app-search";

test("⌘K finds the project's posts, conversations and articles by name (posts and conversations by number too), never another project's", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  for (const p of [project, other]) {
    await prisma.post.create({ data: { projectId: p.id, boardId: p.boards[0]!.id, authorId: owner.id, number: 7, title: "Dark mode" } });
    await prisma.conversation.create({ data: { projectId: p.id, number: 3, subject: "Dark mode on mobile?", status: "OPEN", origin: "API", lastMessageAt: new Date() } });
    await prisma.article.create({ data: { projectId: p.id, slug: "dark-mode", title: "Turning on dark mode" } });
  }
  await prisma.conversation.create({
    data: { projectId: project.id, number: 4, subject: "Dark mode for cheap", status: "OPEN", origin: "API", spam: true, lastMessageAt: new Date() },
  });
  actAs(owner);
  const base = `/app/${project.slug}`;
  const { results } = await searchApp(project.slug, "dark");
  expect(results!.map((r) => [r.kind, r.href])).toEqual([
    ["post", `${base}/p/7`],
    ["conversation", `${base}/inbox/3`], // not the spam one
    ["article", `${base}/docs/dark-mode`],
  ]);
  expect((await searchApp(project.slug, "#7")).results!.map((r) => r.href)).toEqual([`${base}/p/7`]);
  // Too short to search: nothing (the menu still matches pages and actions itself).
  expect((await searchApp(project.slug, "d")).results).toEqual([]);
  // Someone outside the team gets nothing.
  actAs(await signUp("Stranger"));
  expect(await searchApp(project.slug, "dark")).toEqual({ error: "Only the project's team can search it" });
});
