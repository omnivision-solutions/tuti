import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { createBoard, deleteBoard, updateBoard } from "./boards";

let project: Awaited<ReturnType<typeof createProject>>;
let boardId: string;

beforeEach(async () => {
  const owner = await signUp();
  project = await createProject(owner);
  boardId = project.boards[0]!.id;
  actAs(owner);
});

const board = (fields: { name?: string; slug: string }) => {
  const form = new FormData();
  form.set("name", fields.name ?? "A board");
  form.set("slug", fields.slug);
  return form;
};

const rename = (id: string, slug: string) => updateBoard(project.slug, id, {}, board({ slug }));

/** Old URL → the slug of the board it now leads to. */
async function redirects() {
  const rows = await prisma.boardRedirect.findMany({
    where: { projectId: project.id },
    select: { slug: true, board: { select: { slug: true } } },
    orderBy: { slug: "asc" },
  });
  return Object.fromEntries(rows.map((r) => [r.slug, r.board.slug]));
}

describe("renaming a board keeps its old URLs working", () => {
  test("every earlier URL leads to the board", async () => {
    expect(await rename(boardId, "ideas")).toEqual({});
    expect(await rename(boardId, "wishlist")).toEqual({});
    expect(await redirects()).toEqual({ "feature-requests": "wishlist", ideas: "wishlist" });
  });

  test("renaming back to an old URL drops that redirect", async () => {
    await rename(boardId, "ideas");
    await rename(boardId, "feature-requests");
    expect(await redirects()).toEqual({ ideas: "feature-requests" });
  });

  test("keeping the URL adds no redirect", async () => {
    expect(await updateBoard(project.slug, boardId, {}, board({ name: "New name", slug: "feature-requests" }))).toEqual(
      {},
    );
    expect(await redirects()).toEqual({});
  });

  test("a new board can take an old URL, which then stops redirecting", async () => {
    await rename(boardId, "ideas");
    expect(await createBoard(project.slug, {}, board({ slug: "feature-requests" }))).toEqual({});
    expect(await redirects()).toEqual({});
  });

  test("another board can take an old URL by renaming", async () => {
    await rename(boardId, "ideas");
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    const bugs = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "bugs" } });
    expect(await rename(bugs.id, "feature-requests")).toEqual({});
    // "feature-requests" is the bugs board now; its old URL "bugs" leads there.
    expect(await redirects()).toEqual({ bugs: "feature-requests" });
  });
});

test("two boards can't share a URL", async () => {
  await createBoard(project.slug, {}, board({ slug: "bugs" }));
  const error = { error: "This project already has a board with that URL" };
  expect(await createBoard(project.slug, {}, board({ slug: "bugs" }))).toEqual(error);
  expect(await rename(boardId, "bugs")).toEqual(error);
  expect(await redirects()).toEqual({});
});

test("the same URL is fine in another project", async () => {
  await createBoard(project.slug, {}, board({ slug: "bugs" }));
  const otherOwner = await signUp();
  const other = await createProject(otherOwner);
  actAs(otherOwner);
  expect(await createBoard(other.slug, {}, board({ slug: "bugs" }))).toEqual({});
});

describe("deleting boards", () => {
  test("only empty boards can be deleted", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    await prisma.post.create({
      data: { projectId: project.id, boardId, authorId: project.team[0]!.userId, number: 1, title: "A post", body: "" },
    });
    expect(await deleteBoard(project.slug, boardId)).toEqual({
      error: "Only empty boards can be deleted. Move its posts to another board first.",
    });
    expect(await prisma.board.count({ where: { id: boardId } })).toBe(1);
  });

  test("a project keeps at least one board", async () => {
    expect(await deleteBoard(project.slug, boardId)).toEqual({ error: "A project needs at least one board" });
  });

  test("deleting a board removes its redirects", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    await rename(boardId, "ideas");
    expect(await deleteBoard(project.slug, boardId)).toEqual({});
    expect(await redirects()).toEqual({});
  });
});
