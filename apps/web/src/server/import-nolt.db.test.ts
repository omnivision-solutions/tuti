import { prisma } from "@tuti/db";
import { importsSettled, NOLT_PAGE } from "@tuti/jobs";
import { FAKE_NOLT_KEY, type NoltFake, noltFixtures, type S3Fake, startNoltFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { createPost } from "@/server/operations/create";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Imports from Nolt (docs/plan.md, Import from Nolt), against the Nolt and S3 fakes. */

let fake: NoltFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startNoltFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
afterEach(() => void (NOLT_PAGE.commentRequests = 30));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...fake.env, ...s3.env, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
    vi.stubEnv(name, value);
  }
  // Two to a page, so every list (and a post's comments) takes several.
  Object.assign(fake, { fixtures: noltFixtures(), pageSize: 2 });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (parts: string[], key = FAKE_NOLT_KEY) => call(startImport, asOwner(), { source: "nolt", key, parts: parts as never });
async function importParts(parts: string[]) {
  await start(parts);
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));

const usersOf = () =>
  prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, email: true, user: { select: { name: true } } } });
const postsOf = () =>
  prisma.post.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: {
      title: true,
      body: true,
      status: true,
      visibility: true,
      createdAt: true,
      voteCount: true,
      board: { select: { name: true, postVisibility: true, off: true } },
      author: { select: { name: true } },
      comments: { orderBy: { createdAt: "asc" }, select: { body: true, author: { select: { name: true } } } },
    },
  });

test("a key Nolt refuses is refused, nothing started; Nolt has no team, changelog, help center or inbox to bring", async () => {
  expect(await refusal(start(["contacts"], "not_a_real_key"))).toEqual({ status: 400, code: "bad_key", message: "Nolt didn't accept this API key. Check you copied all of it, or make a new one." });
  expect(await refusal(start(["team", "contacts"]))).toMatchObject({ status: 400, code: "invalid_input", message: "Nolt has no Team to bring" });
  expect(await refusal(start(["contacts", "changelog"]))).toMatchObject({ status: 400, code: "invalid_input", message: "Nolt has no Changelog to bring" });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("contacts: Nolt's users with an id in the team's app or an address, by that", async () => {
  const done = await importParts(["contacts"]);
  expect(done).toMatchObject({ state: "done", error: null, counts: { contacts: { imported: 3, leftOut: {} } } });
  expect(await usersOf()).toEqual([
    { externalId: "app-mira", email: "e2e-nolt-mira@example.com", user: { name: "Mira Fenwick" } },
    // Without an id in the team's app: their address, as Nolt's own.
    { externalId: "nolt:e2e-nolt-olive@example.com", email: "e2e-nolt-olive@example.com", user: { name: "Olive Owner" } },
    { externalId: "nolt:e2e-nolt-tobias@example.com", email: "e2e-nolt-tobias@example.com", user: { name: "Tobias Quill" } },
  ]);
});

test("feedback: the board comes turned off; posts oldest first with their first comment as their text, statuses, upvotes and comments; what waits for moderation or was rejected stays out", async () => {
  const done = await importParts(["contacts", "feedback"]);
  expect(done.counts).toMatchObject({
    boards: { imported: 1, leftOut: {} },
    posts: { imported: 4, leftOut: { "waiting for moderation": 1, "hidden from the portal": 1 } },
    // Each author's own, and two more: a downvote, and votes by no one Nolt names or with neither id nor address, aren't brought.
    votes: { imported: 6, leftOut: {} },
    comments: { imported: 3, leftOut: { "waiting for moderation": 1 } },
    images: { imported: 2, leftOut: {} },
  });
  // Nolt's API doesn't say who sees the board: turned off (the team's alone) till they turn it on, its posts as the board's.
  const board = { name: "Acme Feedback", postVisibility: "PUBLIC", off: true };
  expect(await postsOf()).toEqual([
    {
      title: "Dark mode",
      body: "Night owls need it.\nEspecially <on> phones.",
      status: "COMPLETED",
      visibility: "PUBLIC",
      createdAt: new Date("2024-01-10T08:00:00.000Z"),
      voteCount: 2,
      board,
      author: { name: "Mira Fenwick" },
      // Nolt's own status-change comment isn't anyone's.
      comments: [
        { body: "Yes please!", author: { name: "Tobias Quill" } },
        { body: "Planning it for June.", author: { name: "Olive Owner" } },
      ],
    },
    expect.objectContaining({ title: "CSV export", body: "For our accountants.", status: "UNDER_REVIEW", voteCount: 2, author: { name: "Tobias Quill" }, comments: [{ body: "On our list, thanks!", author: { name: "Olive Owner" } }] }),
    // A status of the team's own comes as Open; someone with neither id nor address under their name.
    expect.objectContaining({ title: "Keyboard shortcuts", status: "OPEN", voteCount: 1, author: { name: "Juno Park" } }),
    expect.objectContaining({ title: "Quarterly planning", status: "PLANNED", voteCount: 1, author: { name: "Olive Owner" } }),
  ]);
});

test("importing again brings nothing twice", async () => {
  const all = ["contacts", "feedback", "avatars"];
  const first = await importParts(all);
  expect(importSummary(first)).toBe(
    "3 contacts, 1 board, 4 posts, 6 votes, 3 comments, 2 images, 1 profile picture brought across. Left out: 1 post hidden from the portal; 1 post waiting for moderation; 1 comment waiting for moderation.",
  );
  const counted = async () => Promise.all([usersOf(), postsOf(), prisma.vote.count({ where: { projectId: project.id } }), prisma.media.count({ where: { projectId: project.id } })]);
  const before = await counted();
  const again = await importParts(all);
  expect(await counted()).toEqual(before);
  expect(again.counts).toMatchObject({
    contacts: { imported: 0, leftOut: { "already brought across earlier": 3 } },
    posts: { imported: 0, leftOut: { "already brought across earlier": 4 } },
    comments: { imported: 0, leftOut: { "already brought across earlier": 3 } },
  });
});

test("a second board's key makes a board of its own, turned off too; the first stays as the team left it", async () => {
  await importParts(["contacts", "feedback"]);
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { off: false } });
  Object.assign(fake.fixtures, { board: { id: "nb2", name: "Bugs" } });
  for (const post of fake.fixtures.posts) {
    post.id = `bug-${post.id}`;
    post.comments.forEach((comment) => (comment.id = `bug-${String(comment.id)}`));
  }
  const done = await importParts(["contacts", "feedback"]);
  expect(done.counts).toMatchObject({ boards: { imported: 1, leftOut: {} }, posts: { imported: 4 } });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { name: true, off: true, _count: { select: { posts: true } } } })).toEqual([
    { name: "Acme Feedback", off: false, _count: { posts: 4 } },
    { name: "Bugs", off: true, _count: { posts: 4 } },
  ]);
});

test("a Nolt board named as a board the team has on with posts of its own comes as a new board, turned off: the team's stays on", async () => {
  await call(createPost, asOwner(), { board: "feature-requests", title: "Our own idea" });
  Object.assign(fake.fixtures, { board: { id: "nb1", name: "Feature requests" } });
  await importParts(["contacts", "feedback"]);
  expect(
    await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { name: true, off: true, posts: { orderBy: { number: "asc" }, select: { title: true } } } }),
  ).toEqual([
    { name: "Feature requests", off: false, posts: [{ title: "Our own idea" }] },
    { name: "Feature requests", off: true, posts: [{ title: "Dark mode" }, { title: "CSV export" }, { title: "Keyboard shortcuts" }, { title: "Quarterly planning" }] },
  ]);
});

test("a Nolt board named as the new project's untouched board takes it, turned off", async () => {
  Object.assign(fake.fixtures, { board: { id: "nb1", name: "Feature requests" } });
  await importParts(["contacts", "feedback"]);
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { name: true, off: true, _count: { select: { posts: true } } } })).toEqual([
    { name: "Feature requests", off: true, _count: { posts: 4 } },
  ]);
});

test("comments over several pages, each a request's worth, all come and the import ends", async () => {
  // Two to a page (beforeEach): Dark mode and CSV export each need a further request, so the comments step takes pages.
  NOLT_PAGE.commentRequests = 1;
  const done = await importParts(["contacts", "feedback"]);
  expect(done).toMatchObject({ state: "done", error: null, counts: { comments: { imported: 3, leftOut: { "waiting for moderation": 1 } } } });
  expect(await prisma.comment.count({ where: { post: { projectId: project.id } } })).toBe(3);
});
