import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import PostPage from "./page";

/**
 * A post's address is /feedback/<board>/<title>-<number>, and the number is what finds it: a link
 * made before the post was retitled, moved to another board or merged goes to where it is now.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const open = (board: string, post: string) =>
  PostPage({ params: Promise.resolve({ project: project.slug, board, post }), searchParams: Promise.resolve({}) } as never);

async function post(title: string, boardId = project.boards[0]!.id) {
  const number = (await prisma.project.update({ where: { id: project.id }, data: { postCount: { increment: 1 } } })).postCount;
  return prisma.post.create({ data: { projectId: project.id, boardId, authorId: owner.id, number, title, body: "" } });
}

test("a post's current address renders it; an out-of-date board or title goes to the current one", async () => {
  const dark = await post("Dark mode");
  expect(await open("feature-requests", `dark-mode-${dark.number}`)).toBeTruthy();

  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  // Moved to another board: same title, new board.
  await prisma.post.update({ where: { id: dark.id }, data: { boardId: bugs.id } });
  expect(await redirectTarget(open("feature-requests", `dark-mode-${dark.number}`))).toBe(`/feedback/bugs/dark-mode-${dark.number}`);
  // Then retitled.
  await prisma.post.update({ where: { id: dark.id }, data: { title: "Dark theme" } });
  expect(await redirectTarget(open("feature-requests", `dark-mode-${dark.number}`))).toBe(`/feedback/bugs/dark-theme-${dark.number}`);
  // Any board in the link: the number decides.
  expect(await redirectTarget(open("no-such-board", String(dark.number)))).toBe(`/feedback/bugs/dark-theme-${dark.number}`);
  expect(await open("bugs", `dark-theme-${dark.number}`)).toBeTruthy();
});

test("a merged post goes to the one it was merged into, on that one's board", async () => {
  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  const original = await post("Crash on export", bugs.id);
  const duplicate = await post("Export crashes");
  await prisma.post.update({ where: { id: duplicate.id }, data: { duplicateOfId: original.id } });
  expect(await redirectTarget(open("feature-requests", `export-crashes-${duplicate.number}`))).toBe(`/feedback/bugs/crash-on-export-${original.number}`);
});
