import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateMetadata as boardMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/page";
import { actAs, createProject, signUp } from "@/test/helpers";

import { createBoard, deleteBoard, setBoardOff, updateBoard } from "./boards";

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

  test("a board whose posts were all merged into posts elsewhere can be deleted: they move to their originals' boards", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    const bugs = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "bugs" } });
    const post = (boardId: string, number: number, duplicateOfId?: string) =>
      prisma.post.create({
        data: { projectId: project.id, boardId, authorId: project.team[0]!.userId, number, title: "A post", body: "", duplicateOfId },
      });
    const original = await post(boardId, 1);
    const duplicate = await post(bugs.id, 2, original.id);

    expect(await deleteBoard(project.slug, bugs.id)).toEqual({});
    expect(await prisma.board.count({ where: { id: bugs.id } })).toBe(0);
    expect(await prisma.post.findUniqueOrThrow({ where: { id: duplicate.id }, select: { boardId: true, duplicateOfId: true } })).toEqual({
      boardId,
      duplicateOfId: original.id,
    });
  });

  test("a post moved onto a board while it's being deleted keeps the board, and isn't deleted with it", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    const bugs = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "bugs" } });
    const author = project.team[0]!.userId;
    const original = await prisma.post.create({ data: { projectId: project.id, boardId, authorId: author, number: 1, title: "A post", body: "" } });
    await prisma.post.create({
      data: { projectId: project.id, boardId: bugs.id, authorId: author, number: 2, title: "A post", body: "", duplicateOfId: original.id },
    });
    // The move, not yet committed, while the board is deleted.
    let commit = () => {};
    let moved = () => {};
    const isMoved = new Promise<void>((resolve) => (moved = resolve));
    const moving = prisma.$transaction(
      async (tx) => {
        await tx.post.update({ where: { id: original.id }, data: { boardId: bugs.id } });
        moved();
        await new Promise<void>((resolve) => (commit = resolve));
      },
      { timeout: 20_000 },
    );
    await isMoved;
    const deleting = deleteBoard(project.slug, bugs.id);
    await vi.waitFor(
      async () => {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(waiting).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 25 },
    );
    commit();
    await moving;
    expect(await deleting).toEqual({ error: "Only empty boards can be deleted. Move its posts to another board first." });
    expect(await prisma.post.findUniqueOrThrow({ where: { id: original.id }, select: { boardId: true } })).toEqual({ boardId: bugs.id });
  });

  test("a merged post's original on the same board keeps the board", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    const author = project.team[0]!.userId;
    const original = await prisma.post.create({ data: { projectId: project.id, boardId, authorId: author, number: 1, title: "A post", body: "" } });
    await prisma.post.create({
      data: { projectId: project.id, boardId, authorId: author, number: 2, title: "A post", body: "", duplicateOfId: original.id },
    });
    expect(await deleteBoard(project.slug, boardId)).toEqual({
      error: "Only empty boards can be deleted. Move its posts to another board first.",
    });
  });

  test("a project keeps at least one board", async () => {
    expect(await deleteBoard(project.slug, boardId)).toEqual({ error: "A project needs at least one board" });
  });

  test("deleting the last two boards at once keeps one", async () => {
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    const bugs = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, slug: "bugs" }, select: { id: true } });
    // Another delete, holding the project's lock as deleteBoard does, not yet committed, while this one runs.
    let commit = () => {};
    let held = () => {};
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR NO KEY UPDATE`;
        await tx.board.delete({ where: { id: bugs.id } });
        held();
        await new Promise<void>((resolve) => (commit = resolve));
      },
      { timeout: 20_000 },
    );
    await isHeld;
    const deleting = deleteBoard(project.slug, boardId);
    await vi.waitFor(
      async () => {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(waiting).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 25 },
    );
    commit();
    await other;
    expect(await deleting).toEqual({ error: "A project needs at least one board" });
    expect(await prisma.board.count({ where: { projectId: project.id } })).toBe(1);
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
    vi.stubEnv("BILLING_CONFIG", billingFile());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const setPlan = (plan: null | "pro" | "business") => prisma.project.update({ where: { id: project.id }, data: { plan } });
  const boards = () => prisma.board.count({ where: { projectId: project.id } });

  test("Free: 2 boards, then Upgrade to Pro", async () => {
    expect(await createBoard(project.slug, {}, board({ slug: "bugs" }))).toEqual({});
    expect(await createBoard(project.slug, {}, board({ slug: "ideas" }))).toEqual({
      error: "Projects on the Free plan have up to 2 feedback boards. Upgrade to Pro in Settings → Billing to add more.",
    });
    expect(await boards()).toBe(2);
  });

  test("Pro: 5 boards, then Upgrade to Business", async () => {
    await setPlan("pro");
    for (const slug of ["b2", "b3", "b4", "b5"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await createBoard(project.slug, {}, board({ slug: "b6" }))).toEqual({
      error: "Projects on the Pro plan have up to 5 feedback boards. Upgrade to Business in Settings → Billing to add more.",
    });
    expect(await boards()).toBe(5);
  });

  test("Business: no limit", async () => {
    await setPlan("business");
    for (const slug of ["b2", "b3", "b4", "b5", "b6"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await boards()).toBe(6);
  });

  test("a project that dropped to Free keeps its boards, but can't add more", async () => {
    await setPlan("pro");
    await createBoard(project.slug, {}, board({ slug: "bugs" }));
    await createBoard(project.slug, {}, board({ slug: "ideas" }));
    await setPlan(null);
    expect((await createBoard(project.slug, {}, board({ slug: "more" }))).error).toMatch(/up to 2 feedback boards/);
    expect(await boards()).toBe(3);
    expect(await updateBoard(project.slug, boardId, {}, board({ name: "Renamed", slug: "feature-requests" }))).toEqual({});
  });

  test("a board turned off turns on only while there's room for one more that's on, as after an upgrade; off, it still counts for new ones", async () => {
    // Two boards an import brought past the limit, off.
    const [ideas, bugs] = await Promise.all(
      ["ideas", "bugs"].map((slug) => prisma.board.create({ data: { projectId: project.id, slug, name: slug, off: true } })),
    );
    expect(await setBoardOff(project.slug, ideas!.id, false)).toEqual({});
    expect(await setBoardOff(project.slug, bugs!.id, false)).toEqual({
      error: "Projects on the Free plan have up to 2 feedback boards. Upgrade to Pro in Settings → Billing to turn it on.",
    });
    await setPlan("pro");
    expect(await setBoardOff(project.slug, bugs!.id, false)).toEqual({});
    expect(await prisma.board.count({ where: { projectId: project.id, off: false } })).toBe(3);
    // Turning one off makes room to turn another on, never to make another: else boards turned off would be a way
    // past the limit.
    await setPlan(null);
    expect(await setBoardOff(project.slug, ideas!.id, true)).toEqual({});
    expect(await setBoardOff(project.slug, bugs!.id, true)).toEqual({});
    expect((await createBoard(project.slug, {}, board({ slug: "more" }))).error).toMatch(/up to 2 feedback boards/);
    expect(await setBoardOff(project.slug, ideas!.id, false)).toEqual({});
  });

  test("two boards at once for the last place: only one is made", async () => {
    const results = await Promise.all([createBoard(project.slug, {}, board({ slug: "one" })), createBoard(project.slug, {}, board({ slug: "two" }))]);
    expect(results.filter((result) => result.error)).toHaveLength(1);
    expect(await boards()).toBe(2);
  });

  test("self-hosted (no plans), no limit", async () => {
    vi.stubEnv("BILLING_CONFIG", "");
    for (const slug of ["b2", "b3", "b4", "b5", "b6"]) {
      expect(await createBoard(project.slug, {}, board({ slug }))).toEqual({});
    }
    expect(await boards()).toBe(6);
  });
});
