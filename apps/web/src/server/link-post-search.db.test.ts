import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { findPostsToComplete } from "./changelog";
import { findPostsToLink } from "./inbox";

test("Link post… finds any of the project's posts by number or title, however old or unvoted; never a merged one, nor another project's", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const post = (projectId: string, boardId: string, number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId, boardId, authorId: owner.id, number, title, ...extra } });
  const board = project.boards[0]!.id;
  // The oldest, with no votes: what a preloaded list of the most voted and newest leaves out.
  const old = await post(project.id, board, 1, "Export reports to CSV", { createdAt: new Date("2025-01-01") });
  await post(project.id, board, 2, "CSV import", { voteCount: 30 });
  await post(project.id, board, 3, "Export to CSV again", { duplicateOfId: old.id });
  await post(other.id, other.boards[0]!.id, 4, "CSV everywhere");
  actAs(owner);

  const titles = async (q: string) => (await findPostsToLink(project.slug, q)).posts?.map((p) => `#${p.number} ${p.title}`);
  // By title: the most voted first.
  expect(await titles("csv")).toEqual(["#2 CSV import", "#1 Export reports to CSV"]);
  // A "#" before it is the picker's, not the title's.
  expect(await titles("#csv")).toEqual(["#2 CSV import", "#1 Export reports to CSV"]);
  // By number: that one first, then titles with it.
  expect(await titles("#1")).toEqual(["#1 Export reports to CSV"]);
  // Nothing typed: the newest.
  expect(await titles("")).toEqual(["#2 CSV import", "#1 Export reports to CSV"]);
  // Not the team's: nothing.
  actAs(await signUp("Stranger"));
  expect(await findPostsToLink(project.slug, "csv")).toEqual({ error: "Only the project's team can link conversations to posts" });
});

test("a changelog entry's Link post… finds planned, in-progress and completed posts, however many there are; not open or merged ones", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!.id;
  const post = (number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId: project.id, boardId: board, authorId: owner.id, number, title, ...extra } });
  const old = await post(1, "Calendar sync", { status: "PLANNED", createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01") });
  await post(2, "Calendar export", { status: "OPEN" });
  await post(3, "Calendar sync again", { status: "PLANNED", duplicateOfId: old.id });
  await post(4, "Calendar in the widget", { status: "IN_PROGRESS" });
  // More completed posts, changed since, than a preloaded list of the latest 100 holds.
  await prisma.post.createMany({
    data: Array.from({ length: 101 }, (_, i) => ({ projectId: project.id, boardId: board, authorId: owner.id, number: 5 + i, title: `Fix ${i}`, status: "COMPLETED" as const })),
  });
  actAs(owner);

  const found = async (q: string) => (await findPostsToComplete(project.slug, q)).posts?.map((p) => `#${p.number} ${p.title}`);
  expect(await found("calendar")).toEqual(["#4 Calendar in the widget", "#1 Calendar sync"]);
  // By number: that one first (then titles with the digit); not an open one.
  expect((await found("#1"))?.[0]).toBe("#1 Calendar sync");
  expect(await found("#2")).not.toContain("#2 Calendar export");
  actAs(await signUp("Stranger"));
  expect(await findPostsToComplete(project.slug, "calendar")).toEqual({ error: "Only the project's team can write the changelog" });
});
