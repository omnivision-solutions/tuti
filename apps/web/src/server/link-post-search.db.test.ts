import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

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
