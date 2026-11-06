import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { FEEDBACK_PAGE, handlers, IMPORT_KEY, importsSettled, upsertProjectUser } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { FAKE_FEATUREBASE_KEY, FAKE_OPENAI_KEY, type FeaturebaseFake, featurebaseFixtures, type OpenAIFake, type S3Fake, startFeaturebaseFake, startOpenAIFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { addSampleContent } from "./sample-content";

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
  const started = await call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts", "feedback", "avatars"] });
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
    // The post's and the comment's.
    images: { imported: 2, leftOut: {} },
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

  // Comments flat and in date order, the reply after the comment it answers.
  expect(await prisma.comment.findMany({ where: { postId: dark.id }, orderBy: { createdAt: "asc" }, select: { body: true, createdAt: true, votersEmailDueAt: true, author: { select: { name: true } } } })).toEqual([
    { body: "Yes please!", createdAt: new Date("2024-01-11T09:00:00.000Z"), votersEmailDueAt: null, author: { name: "Tobias Quill" } },
    { body: "On our list, thanks!", createdAt: new Date("2024-01-14T09:00:00.000Z"), votersEmailDueAt: null, author: { name: "Fern Former" } },
  ]);
  // A comment's image is copied, as a post's is.
  const [withImage] = await prisma.comment.findMany({ where: { postId: dark.id }, orderBy: { createdAt: "asc" }, select: { content: true } });
  const image = (withImage!.content as { content: { type: string; attrs?: { mediaId: string } }[] }).content.find((node) => node.type === "image");
  expect(await prisma.media.findUniqueOrThrow({ where: { id: image!.attrs!.mediaId } })).toMatchObject({ projectId: project.id, status: "READY" });
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

test("a comment that's only an image comes across with it", async () => {
  const [first] = fake.fixtures.comments;
  fake.fixtures.comments = [{ ...structuredClone(first!), content: `<p><img src="${fake.url}/files/shot.png"></p>` }];
  await importFeedback();
  const { import: done } = await call(getImport, asOwner(), {});
  expect(done!.counts).toMatchObject({ comments: { imported: 1, leftOut: {} }, images: { imported: 2 } });
  const [only] = await prisma.comment.findMany({ where: { projectId: project.id }, select: { body: true, content: true } });
  expect(only!.body.trim()).toBe("");
  expect(JSON.stringify(only!.content)).toContain('"type":"image"');
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

test("a contact matched by address to a user the team's app signed in keeps that user's own avatar: the import doesn't copy or clear it", async () => {
  const image = "http://127.0.0.1:9/avatars/42.png";
  const signedIn = await upsertProjectUser(project.id, "signed-in-mira", { name: "Mira", email: "e2e-mira@example.com", image });
  fake.fixtures.contacts[0]!.userId = null;
  await importFeedback();
  expect(await prisma.user.findUniqueOrThrow({ where: { id: signedIn }, select: { image: true, imageId: true } })).toEqual({ image, imageId: null });
  const { import: done } = await call(getImport, asOwner(), {});
  expect(done!.counts.avatars).toBeUndefined();
});

test("a repeat import after a post was deleted in Featurebase goes on: the post and its votes here stay, and the rest come across", async () => {
  await importFeedback();
  const gone = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "Sync with calendars" }, select: { id: true, voteCount: true } });
  // Gone from Featurebase since (its voters answer 404), and a new vote and a new comment on another post meanwhile.
  fake.fixtures.posts = fake.fixtures.posts.filter((post) => post.title !== "Sync with calendars");
  fake.fixtures.voters["65f0000000000000000000p2"]!.push({ object: "contact", ...fake.fixtures.contacts[1]!, type: "customer", createdAt: "2024-03-01T00:00:00.000Z" });
  fake.fixtures.comments.push({ ...fake.fixtures.comments[0]!, id: "65f0000000000000000000cz", postId: "65f0000000000000000000p2", content: "<p>Any news?</p>", createdAt: "2024-03-03T09:00:00.000Z" });
  await importFeedback();
  const { import: again } = await call(getImport, asOwner(), {});
  expect(again).toMatchObject({ state: "done", error: null, counts: { votes: { imported: 1 }, comments: { imported: 1 } } });
  expect(await prisma.comment.findFirst({ where: { body: "Any news?" }, select: { post: { select: { title: true, commentCount: true } } } })).toMatchObject({ post: { title: "Export fails on Safari", commentCount: 1 } });
  expect(await prisma.post.findUniqueOrThrow({ where: { id: gone.id }, select: { voteCount: true } })).toEqual({ voteCount: gone.voteCount });
  expect(await prisma.vote.count({ where: { post: { projectId: project.id, title: "Export fails on Safari" } } })).toBe(3);
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
    images: { imported: 0, leftOut: { "with no media storage on this server": 3 } },
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

/** Another picture the fake serves, as Featurebase's storage would. */
const picture = async (name: string) => fake.file(name, "image/png", Buffer.from(await (await fetch(`${fake.url}/files/mira.png`)).arrayBuffer()));

test("past a page's time, what's left of it goes to the next page; one post's images past its hard limit are left out", async () => {
  fake.fixtures.contacts[3]!.profilePicture = await picture("juno.png");
  // The step each page ran, in order.
  const pages: string[] = [];
  const importStep = handlers.importStep;
  handlers.importStep = async (input, log) => {
    pages.push((await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } })).step);
    return importStep(input, log);
  };
  // A clock that moves on each look: once a page has done something, it's past its soft limit.
  let now = 0;
  Object.assign(FEEDBACK_PAGE, { softMs: 0, avatarsAtOnce: 1, now: () => ++now });
  try {
    await importFeedback();
  } finally {
    handlers.importStep = importStep;
  }
  let counts = (await call(getImport, asOwner(), {})).import!.counts;
  // The post's image and the comment's.
  expect(counts).toMatchObject({ posts: { imported: 5 }, images: { imported: 2 }, avatars: { imported: 2 } });
  expect(await prisma.user.count({ where: { imageId: { not: null }, ssoIdentity: { is: { projectId: project.id } } } })).toBe(2);
  // One post a page (Featurebase's 10, 2 to its page: 5 pages without the limit), one avatar a page (else 1).
  expect(pages.filter((step) => step === "posts")).toHaveLength(10);
  expect(pages.filter((step) => step === "avatars")).toHaveLength(2);
  // Comments too, past the limit: one with something to copy a page (Featurebase's 10, 2 to its page: 5 without it).
  expect(pages.filter((step) => step === "comments")).toHaveLength(9);

  // A page whose first post's images begin past its hard limit leaves them out; a comments page's too.
  project = await createProject(owner);
  Object.assign(FEEDBACK_PAGE, { ...limits, hardMs: -1 });
  await importFeedback();
  counts = (await call(getImport, asOwner(), {})).import!.counts;
  expect(counts).toMatchObject({ posts: { imported: 5 }, images: { leftOut: { "that couldn't be fetched": 2 } } });
});

test("a comment whose images run past a page's time goes to the next page whole, its images with it, once", async () => {
  // A comment with two images after the first: the page's time runs out as its first image is fetched.
  const png = Buffer.from(await (await fetch(`${fake.url}/files/mira.png`)).arrayBuffer());
  const [late, later] = [fake.file("late.png", "image/png", png), fake.file("later.png", "image/png", png)];
  const [first] = fake.fixtures.comments;
  fake.fixtures.comments.splice(1, 0, { ...structuredClone(first!), id: "65f0000000000000000000cz", createdAt: "2024-01-11T10:00:00.000Z", content: `<p>Two more:</p><img src="${late}"><img src="${later}">` });
  let now = 0;
  Object.assign(FEEDBACK_PAGE, { softMs: 100, now: () => now });
  fake.onFile = (name) => {
    if (name === "late.png") {
      now += 1000;
    }
  };
  try {
    await importFeedback();
  } finally {
    fake.onFile = undefined;
  }
  const comment = await prisma.comment.findMany({ where: { projectId: project.id, body: { contains: "Two more:" } }, select: { content: true } });
  expect(comment).toHaveLength(1);
  expect(JSON.stringify(comment[0]!.content).match(/"type":"image"/g)).toHaveLength(2);
  expect((await call(getImport, asOwner(), {})).import!.counts.comments).toMatchObject({ imported: 4 });
});

test("a page of comments cut short goes on after the last one done, even when one before it is gone from Featurebase meanwhile", async () => {
  const importStep = handlers.importStep;
  let cut = false;
  handlers.importStep = async (input, log) => {
    // Before the second comments page (pages run one inside another, inline): the last comment done is deleted in
    // Featurebase, so the list shifts up by one.
    const { step, cursor } = await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } });
    const after = step === "comments" && cursor?.startsWith("{") && (JSON.parse(cursor) as { after: { id: string } | null }).after;
    if (after && !cut) {
      cut = true;
      fake.fixtures.comments = fake.fixtures.comments.filter((comment) => comment.id !== after.id);
    }
    return importStep(input, log);
  };
  let now = 0;
  Object.assign(FEEDBACK_PAGE, { softMs: 0, now: () => ++now });
  try {
    await importFeedback();
  } finally {
    handlers.importStep = importStep;
  }
  expect((await call(getImport, asOwner(), {})).import!.counts).toMatchObject({ comments: { imported: 3 }, notes: { imported: 1 } });
});

test("profile pictures are copied several at a time; past a page's time, the next page goes on from the last one copied; one picture several contacts share is copied once", async () => {
  // Three contacts with an uploaded picture each.
  fake.fixtures.contacts[1]!.profilePicture = await picture("tobias.png");
  fake.fixtures.contacts[3]!.profilePicture = await picture("juno.png");
  const pages: string[] = [];
  const importStep = handlers.importStep;
  handlers.importStep = async (input, log) => {
    pages.push((await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } })).step);
    return importStep(input, log);
  };
  // Past the soft limit once a page has copied any: two at once fit the first page (one at a time, one would), the third the next.
  let now = 0;
  Object.assign(FEEDBACK_PAGE, { softMs: 0, avatarsAtOnce: 2, now: () => ++now });
  try {
    await importFeedback();
  } finally {
    handlers.importStep = importStep;
  }
  expect(pages.filter((step) => step === "avatars")).toHaveLength(2);
  expect((await call(getImport, asOwner(), {})).import!.counts.avatars).toEqual({ imported: 3, leftOut: {} });
  const pictured = { imageId: { not: null }, ssoIdentity: { is: { projectId: project.id } } };
  expect(await prisma.user.count({ where: pictured })).toBe(3);

  // The three with one picture, in another project: copied once, all at once.
  for (const n of [1, 3]) {
    fake.fixtures.contacts[n]!.profilePicture = fake.fixtures.contacts[0]!.profilePicture;
  }
  project = await createProject(owner);
  Object.assign(FEEDBACK_PAGE, { softMs: 0, avatarsAtOnce: 3 });
  await importFeedback();
  const shared = await prisma.user.findMany({ where: { imageId: { not: null }, ssoIdentity: { is: { projectId: project.id } } }, select: { imageId: true } });
  expect(shared).toHaveLength(3);
  expect(new Set(shared.map((user) => user.imageId)).size).toBe(1);
});

test("profile pictures come last, after the duplicate check; an import from before they were a part, at them, goes on with the rest and copies them last", async () => {
  // The step each page ran, in order.
  const pages: string[] = [];
  const importStep = handlers.importStep;
  handlers.importStep = async (input, log) => {
    pages.push((await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } })).step);
    return importStep(input, log);
  };
  try {
    const started = await importFeedback();
    expect([...new Set(pages)]).toEqual(["contacts", "posts", "votes", "comments", "embeddings", "avatars"]);

    // One from before: at Feedback's avatars (they came before its duplicate check), its parts without them.
    const pictured = { imageId: { not: null }, ssoIdentity: { is: { projectId: project.id } } };
    const ids = (await prisma.user.findMany({ where: pictured, select: { id: true } })).map((user) => user.id);
    expect(ids).toHaveLength(1);
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { imageId: null, image: `${fake.url}/files/mira.png` } });
    await prisma.dataImport.update({
      where: { id: started.id },
      data: { state: "RUNNING", apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), parts: ["contacts", "feedback"], step: "avatars", cursor: ids[0], counts: {}, finishedAt: null },
    });
    pages.length = 0;
    await handlers.importStep({ importId: started.id }, log);
    await importsSettled();
    expect(pages).toEqual(["avatars", "embeddings", "avatars"]);
    expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ state: "DONE", parts: ["contacts", "feedback", "avatars"], counts: { avatars: { imported: 1 } } });
    expect(await prisma.user.count({ where: pictured })).toBe(1);
  } finally {
    handlers.importStep = importStep;
  }
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

test("sample content added during setup (on the new project's board) doesn't stop that board being reused: both of Featurebase's boards come across on the free plan", async () => {
  vi.stubEnv("PLANS", "on");
  await addSampleContent(project.id, owner.id);
  expect(await prisma.post.count({ where: { boardId: project.boards[0]!.id, sample: true } })).toBeGreaterThan(0);
  const ideas = fake.fixtures.boards[0]!;
  Object.assign(ideas, { name: "Ideas", localization: { ...(ideas.localization as object), name: { en: "Ideas" } } });
  await importFeedback();
  expect((await call(getImport, asOwner(), {})).import!.counts.boards).toEqual({ imported: 2, leftOut: { "only some people see": 3 } });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })).toEqual([
    { id: project.boards[0]!.id, name: "Ideas" },
    { id: expect.any(String), name: "Bugs" },
  ]);
});

test("on the free plan, a board matching the new project's by name keeps it wherever it comes; the plan's other slot goes to the first of the rest", async () => {
  vi.stubEnv("PLANS", "on");
  // Three distinct boards for two slots: one is folded whichever order they're resolved in. The new project's board is
  // one of the two, matched by name ("Feature requests", last here), so the first of the others comes and the second folds.
  const [requests, bugs] = fake.fixtures.boards;
  const ideas = { ...structuredClone(bugs!), id: "65f0000000000000000000b8", name: "Ideas", localization: { name: { en: "Ideas" } } };
  fake.fixtures.boards = [ideas, bugs!, requests!];
  await importFeedback();
  expect((await call(getImport, asOwner(), {})).import!.counts.boards).toEqual({ imported: 2, leftOut: { "past the plan's board limit, their posts in the last board": 1 } });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })).toEqual([
    { id: project.boards[0]!.id, name: "Feature requests" },
    { id: expect.any(String), name: "Ideas" },
  ]);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "Export fails on Safari" }, select: { board: { select: { name: true } } } })).toEqual({ board: { name: "Ideas" } });
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
