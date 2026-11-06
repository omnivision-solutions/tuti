import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { FEEDBACK_PAGE, handlers, IMPORT_KEY, importsSettled } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { FAKE_FEATUREBASE_KEY, FAKE_OPENAI_KEY, type FeaturebaseFake, featurebaseFixtures, type OpenAIFake, type S3Fake, startFeaturebaseFake, startOpenAIFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Feedback from Featurebase (docs/plan.md, Switching from Featurebase, I3), against the Featurebase, S3 and OpenAI fakes. */

const log = { info: () => {}, warn: () => {} };
let fake: FeaturebaseFake;
let s3: S3Fake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3, openai] = await Promise.all([startFeaturebaseFake(), startS3Fake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close(), openai.close()]));
const limits = { ...FEEDBACK_PAGE };
afterEach(() => void Object.assign(FEEDBACK_PAGE, limits));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...fake.env, ...s3.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
    vi.stubEnv(name, value);
  }
  // A few to a page, so every list takes several.
  Object.assign(fake, { fixtures: featurebaseFixtures(), pageSize: 2 });
  fake.forbidden.clear();
  owner = await signUp("Olive Owner");
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  // The owner is Featurebase's first admin; the second has left.
  fake.fixtures.admins[0]!.email = owner.email;
  fake.fixtures.admins[1]!.email = `e2e-${randomUUID()}@example.com`;
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const importFeedback = async () => {
  const started = await call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts", "feedback"] });
  await importsSettled();
  return started;
};
const postsOf = () =>
  prisma.post.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: {
      number: true,
      title: true,
      body: true,
      status: true,
      eta: true,
      createdAt: true,
      voteCount: true,
      commentCount: true,
      shippedEmailsDueAt: true,
      board: { select: { name: true } },
      author: { select: { name: true } },
      events: { select: { from: true, to: true, createdAt: true } },
    },
  });
/** Everything feedback made, counted: what a second run mustn't add to. */
const made = async () => ({
  boards: await prisma.board.count({ where: { projectId: project.id } }),
  posts: await prisma.post.count({ where: { projectId: project.id } }),
  votes: await prisma.vote.count({ where: { projectId: project.id } }),
  comments: await prisma.comment.count({ where: { projectId: project.id } }),
  notes: await prisma.postNote.count({ where: { post: { projectId: project.id } } }),
  events: await prisma.postEvent.count({ where: { post: { projectId: project.id } } }),
  media: await prisma.media.count({ where: { projectId: project.id } }),
  users: await prisma.user.count({ where: { OR: [{ ssoIdentity: { is: { projectId: project.id } } }, { placeholderProjectId: project.id }] } }),
});

test("Feedback comes across quietly: boards, posts with their content, images, dates, statuses and numbers, votes, comments and notes; what only some people see is left out, counted", async () => {
  await prisma.webhook.create({ data: { projectId: project.id, url: "https://hooks.example.com/tuti", secret: "s", events: ["post.created", "post.updated", "comment.created", "vote.created"], createdById: owner.id } });
  const emailed = mailbox.emails.length;
  await importFeedback();

  const { import: done } = await call(getImport, asOwner(), {});
  expect(done).toMatchObject({ state: "done", error: null });
  expect(done!.counts).toEqual({
    contacts: { imported: 3, leftOut: {} },
    boards: { imported: 2, leftOut: { "only some people see": 3 } },
    posts: { imported: 5, leftOut: { "only some people see": 3, "hidden from the portal": 1, "waiting for moderation": 1 } },
    images: { imported: 1, leftOut: { "in comments, which have none in Tuti": 1 } },
    // Each author's own (5), a guest author's among them, and the others' (3); only the guest who isn't the author left out.
    votes: { imported: 8, leftOut: { "by guests": 1 } },
    comments: { imported: 3, leftOut: { "private but not by the team": 1, "deleted or spam": 2, "waiting for moderation": 1, "on posts left out": 1 } },
    notes: { imported: 1, leftOut: {} },
    avatars: { imported: 1, leftOut: {} },
  });
  expect(importSummary(done!)).toContain("8 votes");
  expect(importSummary(done!)).toContain("1 vote by guests;");

  // The new project's board is Featurebase's of the same name, with its words; the other is made; hidden ones aren't.
  expect(await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { name: true, slug: true, description: true, postButton: true, detailsPlaceholder: true } })).toEqual([
    { name: "Feature requests", slug: "feature-requests", description: "Ideas for the product", postButton: "Share an idea", detailsPlaceholder: "What would help you most?" },
    { name: "Bugs", slug: "bugs", description: null, postButton: null, detailsPlaceholder: null },
  ]);

  const former = await prisma.user.findFirstOrThrow({ where: { placeholderProjectId: project.id }, select: { id: true, name: true } });
  expect(former.name).toBe("Fern Former");
  // Numbered in date order; statuses by name (Planned) or by type; the ETA as its month; the original dates; an event for a status, never a shipped email.
  expect(await postsOf()).toEqual([
    {
      number: 1,
      title: "Dark mode",
      body: expect.stringContaining("Night owls need it."),
      status: "PLANNED",
      eta: new Date("2024-06-01T00:00:00.000Z"),
      createdAt: new Date("2024-01-10T08:00:00.000Z"),
      voteCount: 3,
      commentCount: 2,
      shippedEmailsDueAt: null,
      board: { name: "Feature requests" },
      author: { name: "Mira Fenwick" },
      events: [{ from: "OPEN", to: "PLANNED", createdAt: new Date("2024-01-10T08:00:00.000Z") }],
    },
    expect.objectContaining({ number: 2, title: "Export fails on Safari", status: "IN_PROGRESS", board: { name: "Bugs" }, author: { name: "Fern Former" }, voteCount: 2, commentCount: 0 }),
    expect.objectContaining({ number: 3, title: "Sync with calendars", status: "CLOSED", author: { name: "Juno Park" }, voteCount: 1, commentCount: 1 }),
    // Guests', each under their own name; "In Review" isn't one of Tuti's names, so by its type.
    expect.objectContaining({ number: 4, title: "Keyboard shortcuts", status: "UNDER_REVIEW", author: { name: "Visitor" }, voteCount: 1, commentCount: 0, events: [expect.objectContaining({ to: "UNDER_REVIEW" })] }),
    expect.objectContaining({ number: 5, title: "Export to PDF", author: { name: "Another visitor" } }),
  ]);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).postCount).toBe(5);

  // The post's image is a copy in media storage, with its size; its heading a bold line (posts have none).
  const dark = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: 1 }, select: { id: true, content: true } });
  const [media] = await prisma.media.findMany({ where: { projectId: project.id, uploaderId: owner.id, filename: null }, orderBy: { createdAt: "asc" } });
  expect(media).toMatchObject({ status: "READY", width: 96, height: 64 });
  expect((dark.content as { content: unknown[] }).content).toEqual(
    [
      { type: "paragraph", content: [{ type: "text", text: "Dark mode", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Night owls need it." }] },
      { type: "image", attrs: expect.objectContaining({ mediaId: media!.id, alt: "A sketch", w: 96, h: 64 }) },
    ],
  );

  // Votes: the author's own once; a voter who joined later on their joining; the owner as Featurebase's admin; never a guest.
  const votes = await prisma.vote.findMany({ where: { postId: dark.id }, select: { createdAt: true, user: { select: { name: true, id: true } } }, orderBy: { createdAt: "asc" } });
  expect(votes.map((vote) => [vote.user.name, vote.createdAt.toISOString()])).toEqual([
    ["Mira Fenwick", "2024-01-10T08:00:00.000Z"],
    ["Olive Owner", "2024-01-10T08:00:00.000Z"],
    ["Tobias Quill", "2024-02-20T12:00:00.000Z"],
  ]);
  expect(votes.find((vote) => vote.user.name === "Olive Owner")!.user.id).toBe(owner.id);

  // Comments flat and in date order, the reply after the comment it answers; the image left out of one, its text kept.
  expect(await prisma.comment.findMany({ where: { postId: dark.id }, orderBy: { createdAt: "asc" }, select: { body: true, createdAt: true, votersEmailDueAt: true, author: { select: { name: true } } } })).toEqual([
    { body: "Yes please!", createdAt: new Date("2024-01-11T09:00:00.000Z"), votersEmailDueAt: null, author: { name: "Tobias Quill" } },
    { body: "On our list, thanks!", createdAt: new Date("2024-01-14T09:00:00.000Z"), votersEmailDueAt: null, author: { name: "Fern Former" } },
  ]);
  // The team's private comment is an internal note, the owner's; a user's private one stays out.
  expect(await prisma.postNote.findMany({ where: { postId: dark.id }, select: { body: true, authorId: true, createdAt: true } })).toEqual([
    { body: "Planning it for June.", authorId: owner.id, createdAt: new Date("2024-01-12T09:00:00.000Z") },
  ]);

  // Mira's avatar is a copy too, as Account's photo is; Tobias's placeholder never came.
  const mira = await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "app-user-1" }, select: { user: { select: { image: true, imageId: true } } } });
  expect(mira.user.imageId).toEqual(expect.any(String));
  expect(mira.user.image).toContain(`/media/${mira.user.imageId}/96.webp?s=`);
  expect(await prisma.media.findUniqueOrThrow({ where: { id: mira.user.imageId! } })).toMatchObject({ status: "READY", width: 96 });
  // Kept by the daily release while they're one of the project's users (not only a team member's).
  await prisma.media.updateMany({ where: { projectId: project.id }, data: { attachedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) } });
  await handlers.releaseMedia({}, log);
  expect(await prisma.user.findFirstOrThrow({ where: { imageId: mira.user.imageId } })).toMatchObject({ image: mira.user.image });
  expect(await prisma.media.findUniqueOrThrow({ where: { id: mira.user.imageId! } })).toMatchObject({ attachedAt: expect.any(Date) });

  // Embedded for duplicates, as the post-created job would.
  expect(await prisma.postEmbedding.count({ where: { projectId: project.id } })).toBe(5);
  // Quietly: nothing emailed, no webhook.
  expect(mailbox.emails.length).toBe(emailed);
  expect(await prisma.webhookDelivery.count({ where: { webhook: { projectId: project.id } } })).toBe(0);
});

test("a page run twice, at once or again later, and a second import, bring nothing twice", async () => {
  const started = await importFeedback();
  const before = await made();
  expect(before).toMatchObject({ boards: 2, posts: 5, votes: 8, comments: 3, notes: 1, events: 5 });

  // Each of feedback's steps again from its first page, twice at once: one of them saves.
  for (const step of ["posts", "votes", "comments", "avatars", "embeddings"]) {
    await prisma.dataImport.update({ where: { id: started.id }, data: { state: "RUNNING", apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), step, cursor: null, counts: {} } });
    const results = await Promise.all([handlers.importStep({ importId: started.id }, log), handlers.importStep({ importId: started.id }, log)]);
    expect(results).toContainEqual({ skipped: true });
    await importsSettled();
    expect(await made()).toEqual(before);
  }
  await importFeedback();
  expect(await made()).toEqual(before);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).postCount).toBe(5);
  // The second import says so.
  const already = { imported: 0, leftOut: expect.objectContaining({ "already brought across earlier": expect.any(Number) }) };
  expect((await call(getImport, asOwner(), {})).import!.counts).toMatchObject({
    boards: { imported: 0, leftOut: { "already brought across earlier": 2, "only some people see": 3 } },
    posts: already,
    votes: { imported: 0, leftOut: { "already brought across earlier": 3, "by guests": 1 } },
    comments: already,
    notes: { imported: 0, leftOut: { "already brought across earlier": 1 } },
  });
});

test("past the plan's board limit, a board's posts go into the last board imported; without media storage images are left out, counted, and avatars stay links", async () => {
  vi.stubEnv("PLANS", "on");
  for (const name of Object.keys(s3.env)) {
    vi.stubEnv(name, "");
  }
  // A third board everyone sees: the free plan has room for two.
  const ideas = structuredClone(fake.fixtures.boards[1]!);
  Object.assign(ideas, { id: "65f0000000000000000000b5", name: "Ideas", localization: { name: { en: "Ideas" } } });
  fake.fixtures.boards.push(ideas);
  fake.fixtures.posts.push({ ...structuredClone(fake.fixtures.posts[0]!), id: "65f0000000000000000000pa", boardId: ideas.id, title: "Offline mode", createdAt: "2024-04-01T10:00:00.000Z" });
  await importFeedback();

  const { import: done } = await call(getImport, asOwner(), {});
  expect(done!.counts).toMatchObject({
    boards: { imported: 2, leftOut: { "only some people see": 3, "past the plan's board limit, their posts in the last board": 1 } },
    posts: { imported: 6 },
    images: { imported: 0, leftOut: { "with no media storage on this server": 2, "in comments, which have none in Tuti": 1 } },
  });
  expect(await prisma.board.count({ where: { projectId: project.id } })).toBe(2);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "Offline mode" }, select: { board: { select: { name: true } } } })).toEqual({ board: { name: "Bugs" } });
  // Imported again, the board that went into another for want of room is still said to have.
  await importFeedback();
  expect((await call(getImport, asOwner(), {})).import!.counts.boards).toEqual({
    imported: 0,
    leftOut: { "already brought across earlier": 2, "only some people see": 3, "past the plan's board limit, their posts in the last board": 1 },
  });
  expect(await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "app-user-1" }, select: { user: { select: { image: true, imageId: true } } } })).toEqual({
    user: { image: `${fake.url}/files/mira.png`, imageId: null },
  });
});

test("what didn't happen isn't counted: no boards left out, no images, and two boards of one name are one board, not past a limit, imported again too", async () => {
  // With a limit the two fit in: the new project's board and Bugs.
  vi.stubEnv("PLANS", "on");
  fake.fixtures.boards = fake.fixtures.boards.slice(0, 2);
  fake.fixtures.boards.push({ ...structuredClone(fake.fixtures.boards[1]!), id: "65f0000000000000000000b7", name: "bugs" });
  for (const row of [...fake.fixtures.posts, ...fake.fixtures.comments]) {
    row.content = String(row.content).replace(/<img[^>]*>/g, "");
  }
  await importFeedback();
  const { import: done } = await call(getImport, asOwner(), {});
  expect(done!.counts.boards).toEqual({ imported: 3, leftOut: {} });
  expect(done!.counts).not.toHaveProperty("images");
  expect(await prisma.board.count({ where: { projectId: project.id } })).toBe(2);
  // Again: both are still in one board by their name, not for want of room.
  await importFeedback();
  expect((await call(getImport, asOwner(), {})).import!.counts.boards).toEqual({ imported: 0, leftOut: { "already brought across earlier": 3 } });
});

test("a page of Featurebase's with more posts than one of ours takes comes across in several, numbered in date order, a post merged meanwhile skipping none", async () => {
  fake.pageSize = 100;
  const template = fake.fixtures.posts[1]!;
  for (let n = 1; n <= 30; n++) {
    fake.fixtures.posts.push({ ...structuredClone(template), id: `65f00000000000000000c${String(n).padStart(3, "0")}`, title: `Idea ${n}`, createdAt: new Date(Date.UTC(2025, 0, n)).toISOString() });
  }
  fake.requests.length = 0;
  // Merged in Featurebase after the first of ours brought it: the next goes on after the last it did, not from a
  // position the merge moved (which would skip Idea 21).
  const reads = () => fake.requests.filter((request) => request.startsWith("GET /v2/posts?") && !request.includes("limit=1&") && !request.endsWith("limit=1"));
  const merged = fake.fixtures.posts.findIndex((post) => post.title === "Idea 3");
  const original = fake.requests.push.bind(fake.requests);
  fake.requests.push = (...requests: string[]) => {
    const n = original(...requests);
    if (reads().length === 2 && fake.fixtures.posts[merged]?.title === "Idea 3") {
      fake.fixtures.posts.splice(merged, 1);
    }
    return n;
  };
  await importFeedback();
  // 40 posts in one of Featurebase's pages: read twice, 25 posts a time.
  expect(reads()).toHaveLength(2);
  expect((await call(getImport, asOwner(), {})).import!.counts.posts).toMatchObject({ imported: 35 });
  const titles = (await prisma.post.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { title: true } })).map((post) => post.title);
  expect(titles.slice(-30)).toEqual(Array.from({ length: 30 }, (_, n) => `Idea ${n + 1}`));
});

test("past a page's time, what's left of it goes to the next page; one post's images past its hard limit are left out", async () => {
  fake.fixtures.contacts[3]!.profilePicture = fake.fixtures.contacts[0]!.profilePicture;
  // The step each page ran, in order.
  const pages: string[] = [];
  const importStep = handlers.importStep;
  handlers.importStep = async (input, log) => {
    pages.push((await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } })).step);
    return importStep(input, log);
  };
  // A clock that moves on each look: once a page has done something, it's past its soft limit.
  let now = 0;
  Object.assign(FEEDBACK_PAGE, { softMs: 0, now: () => ++now });
  try {
    await importFeedback();
  } finally {
    handlers.importStep = importStep;
  }
  let counts = (await call(getImport, asOwner(), {})).import!.counts;
  expect(counts).toMatchObject({ posts: { imported: 5 }, images: { imported: 1 }, avatars: { imported: 2 } });
  expect(await prisma.user.count({ where: { imageId: { not: null }, ssoIdentity: { is: { projectId: project.id } } } })).toBe(2);
  // One post a page (Featurebase's 10, 2 to its page: 5 pages without the limit), one avatar a page (else 1).
  expect(pages.filter((step) => step === "posts")).toHaveLength(10);
  expect(pages.filter((step) => step === "avatars")).toHaveLength(2);

  // A page whose first post's images begin past its hard limit leaves them out.
  project = await createProject(owner);
  Object.assign(FEEDBACK_PAGE, { ...limits, hardMs: -1 });
  await importFeedback();
  counts = (await call(getImport, asOwner(), {})).import!.counts;
  expect(counts).toMatchObject({ posts: { imported: 5 }, images: { leftOut: { "that couldn't be fetched": 1 } } });
});

test("a new project's untouched board becomes the first of Featurebase's, costing the plan no slot", async () => {
  vi.stubEnv("PLANS", "on");
  // No board named as the new project's: on the free plan (2) both of these come across, neither folded.
  const ideas = fake.fixtures.boards[0]!;
  Object.assign(ideas, { name: "Ideas", localization: { ...(ideas.localization as object), name: { en: "Ideas" } } });
  await importFeedback();
  expect((await call(getImport, asOwner(), {})).import!.counts.boards).toEqual({ imported: 2, leftOut: { "only some people see": 3 } });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, slug: true, postButton: true } })).toEqual([
    { id: project.boards[0]!.id, name: "Ideas", slug: "ideas", postButton: "Share an idea" },
    { id: expect.any(String), name: "Bugs", slug: "bugs", postButton: null },
  ]);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "Dark mode" }, select: { board: { select: { name: true } } } })).toEqual({ board: { name: "Ideas" } });
  // Its old address leads to it, as after a rename in the app.
  expect(await prisma.boardRedirect.findMany({ where: { projectId: project.id }, select: { slug: true, boardId: true } })).toEqual([{ slug: "feature-requests", boardId: project.boards[0]!.id }]);
});

test("an embedding provider failing leaves the posts unembedded; the import still ends done, everything brought", async () => {
  openai.failNext(500);
  await importFeedback();
  const { import: done } = await call(getImport, asOwner(), {});
  expect(done).toMatchObject({ state: "done", error: null, counts: { posts: { imported: 5 }, comments: { imported: 3 }, avatars: { imported: 1 } } });
  expect(await prisma.postEmbedding.count({ where: { projectId: project.id } })).toBe(0);
});

test("a key that can't read the boards or the posts isn't accepted for Feedback", async () => {
  fake.forbidden.add("/v2/boards");
  await expect(call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts", "feedback"] })).rejects.toMatchObject({
    status: 400,
    code: "cant_read",
    message: "This key can't read Feedback in Featurebase. Use a key that can, or leave Feedback out.",
  });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});
