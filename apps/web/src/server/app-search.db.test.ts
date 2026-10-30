import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { searchApp } from "./app-search";
import { upsertProjectUser } from "./project-users";

test("⌘K finds the project's posts, conversations and articles by name (posts and conversations by number too), never another project's", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  for (const p of [project, other]) {
    await prisma.post.create({ data: { projectId: p.id, boardId: p.boards[0]!.id, authorId: owner.id, number: 7, title: "Dark mode" } });
    await prisma.conversation.create({ data: { projectId: p.id, number: 3, subject: "Dark mode on mobile?", status: "OPEN", origin: "API", lastMessageAt: new Date() } });
    await prisma.article.create({ data: { projectId: p.id, slug: "dark-mode", title: "Turning on dark mode" } });
  }
  await upsertProjectUser(project.id, "u-1", { name: "Dark Helmet", email: "e2e-helmet@example.com" });
  await upsertProjectUser(other.id, "u-2", { name: "Dark Helmet", email: "e2e-helmet@example.com" });
  await prisma.conversation.create({
    data: { projectId: project.id, number: 4, subject: "Dark mode for cheap", status: "OPEN", origin: "API", spam: true, lastMessageAt: new Date() },
  });
  // Merged into #7, and deleted: neither is found.
  const seven = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: 7 } });
  await prisma.post.create({
    data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 9, title: "Dark theme please", duplicateOfId: seven.id },
  });
  await prisma.article.create({ data: { projectId: project.id, slug: "dark-mode-old", title: "Dark mode (old)", deletedAt: new Date() } });
  actAs(owner);
  const base = `/app/${project.slug}`;
  const { results } = await searchApp(project.slug, "dark");
  expect(results!.map((r) => [r.kind, r.href])).toEqual([
    ["post", `${base}/p/7`],
    ["conversation", `${base}/inbox/3`], // not the spam one
    ["article", `${base}/docs/dark-mode`],
    ["user", `${base}/users?q=u-1`], // by their id in the project's product; not the other project's u-2
  ]);
  expect((await searchApp(project.slug, "#7")).results!.map((r) => r.href)).toEqual([`${base}/p/7`]);
  // "_" and "%" are themselves, not LIKE's wildcards.
  expect((await searchApp(project.slug, "__")).results).toEqual([]);
  expect((await searchApp(project.slug, "%%")).results).toEqual([]);
  // A number too big to be one isn't looked up as one (nor does it fail the search).
  expect((await searchApp(project.slug, "99999999999")).results).toEqual([]);
  // Longer than the box takes: nothing, rather than what its first 200 characters match.
  await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 8, title: "a".repeat(200) } });
  expect((await searchApp(project.slug, "a".repeat(200))).results!.map((r) => r.href)).toEqual([`${base}/p/8`]);
  expect((await searchApp(project.slug, `${"a".repeat(200)}b`)).results).toEqual([]);
  // Too short to search: nothing (the menu still matches pages and actions itself).
  expect((await searchApp(project.slug, "d")).results).toEqual([]);
  // Someone outside the team gets nothing.
  actAs(await signUp("Stranger"));
  expect(await searchApp(project.slug, "dark")).toEqual({ error: "Only the project's team can search it" });
});
