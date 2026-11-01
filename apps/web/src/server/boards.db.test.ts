import { prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateMetadata as boardMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/page";
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

test("a board's page, sorted or filtered, points search engines at its plain address", async () => {
  const meta = await boardMetadata({
    params: Promise.resolve({ project: project.slug, board: "feature-requests" }),
    searchParams: Promise.resolve({ sort: "new", status: "planned" }),
  } as never);
  expect(meta.alternates?.canonical).toBe(`http://${project.slug}.localhost:3100/feedback/feature-requests`);
});

test("a board keeps its own words for posting; emptied, they're the defaults again", async () => {
  const texts = () =>
    prisma.board.findUniqueOrThrow({ where: { id: boardId }, select: { postButton: true, titlePlaceholder: true, detailsPlaceholder: true } });
  const form = board({ slug: "feature-requests" });
  form.set("postButton", " Request a feature ");
  form.set("titlePlaceholder", "What should it do?");
  form.set("detailsPlaceholder", "How would it help you?");
  expect(await updateBoard(project.slug, boardId, {}, form)).toEqual({});
  expect(await texts()).toEqual({
    postButton: "Request a feature",
    titlePlaceholder: "What should it do?",
    detailsPlaceholder: "How would it help you?",
  });

  form.set("postButton", "x".repeat(31));
  expect(await updateBoard(project.slug, boardId, {}, form)).toEqual({ error: "Keep it to 30 characters" });

  for (const field of ["postButton", "titlePlaceholder", "detailsPlaceholder"]) {
    form.set(field, "  ");
  }
  expect(await updateBoard(project.slug, boardId, {}, form)).toEqual({});
  expect(await texts()).toEqual({ postButton: null, titlePlaceholder: null, detailsPlaceholder: null });
});

describe("how many boards a plan has (where plans are sold)", () => {
  beforeEach(() => {
    vi.stubEnv("PLANS", "on");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const setPlan = (plan: "FREE" | "PRO" | "BUSINESS") => prisma.project.update({ where: { id: project.id }, data: { plan } });
  const boards = () => prisma.board.count({ where: { projectId: project.id } });

  test("Free: 2 boards, then Upgrade to Pro", async () => {
    expect(await createBoard(project.slug, {}, board({ slug: "bugs" }))).toEqual({});
    expect(await createBoard(project.slug, {}, board({ slug: "ideas" }))).toEqual({
      error: "Projects on the free plan have up to 2 feedback boards. Upgrade to Pro in Settings → Billing to add more.",
    });
    expect(await boards()).toBe(2);
  });

  test("Pro: 5 boards, then Upgrade to Business", async () => {
    await setPlan("PRO");
    for (const slug of ["b2", "b3", "b4", "b5"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await createBoard(project.slug, {}, board({ slug: "b6" }))).toEqual({
      error: "Projects on the Pro plan have up to 5 feedback boards. Upgrade to Business in Settings → Billing to add more.",
    });
    expect(await boards()).toBe(5);
  });

  test("Business: no limit", async () => {
    await setPlan("BUSINESS");
    for (const slug of ["b2", "b3", "b4", "b5", "b6"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await boards()).toBe(6);
  });

  test("a project that dropped to Free keeps its boards, but can't add more", async () => {
    await setPlan("PRO");
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    await createBoard(project.slug, {}, board({ slug: "ideas" }));
    await setPlan("FREE");
    expect((await createBoard(project.slug, {}, board({ slug: "more" }))).error).toMatch(/up to 2 feedback boards/);
    expect(await boards()).toBe(3);
    expect(await updateBoard(project.slug, boardId, {}, board({ name: "Renamed", slug: "feature-requests" }))).toEqual({});
  });

  test("two boards at once for the last place: only one is made", async () => {
    const results = await Promise.all([createBoard(project.slug, {}, board({ slug: "one" })), createBoard(project.slug, {}, board({ slug: "two" }))]);
    expect(results.filter((result) => result.error)).toHaveLength(1);
    expect(await boards()).toBe(2);
  });

  test("self-hosted (no plans), no limit", async () => {
    vi.stubEnv("PLANS", "");
    for (const slug of ["b2", "b3", "b4", "b5", "b6"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await boards()).toBe(6);
  });
});
