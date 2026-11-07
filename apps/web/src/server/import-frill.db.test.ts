import { prisma } from "@tuti/db";
import { CHANGELOG_PAGE, importsSettled } from "@tuti/jobs";
import { FAKE_FRILL_KEY, type FrillFake, frillFixtures, type S3Fake, startFrillFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports from Frill (docs/plan.md, Import from Frill), against the Frill and S3 fakes. */

let fake: FrillFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startFrillFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
const limits = { ...CHANGELOG_PAGE };
afterEach(() => void Object.assign(CHANGELOG_PAGE, limits));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...fake.env, ...s3.env, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
    vi.stubEnv(name, value);
  }
  // Two to a page, so every list takes several.
  Object.assign(fake, { fixtures: frillFixtures(), pageSize: 2 });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (parts: string[], key = FAKE_FRILL_KEY, options: { publicPosts?: boolean } = {}) => call(startImport, asOwner(), { source: "frill", key, parts: parts as never, ...options });
async function importParts(parts: string[], options: { publicPosts?: boolean } = {}) {
  await start(parts, FAKE_FRILL_KEY, options);
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));

const usersOf = () => prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, email: true, user: { select: { name: true } } } });
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
      board: { select: { name: true } },
      author: { select: { name: true } },
      comments: { select: { body: true, author: { select: { name: true } } } },
      notes: { select: { body: true, author: { select: { name: true } } } },
    },
  });
const entriesOf = () =>
  prisma.changelogEntry.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: { title: true, body: true, tags: true, publishedAt: true, posts: { select: { post: { select: { title: true } } } } },
  });

test("a key Frill refuses is refused, nothing started; Frill has no team, help center or inbox to bring", async () => {
  expect(await refusal(start(["contacts"], "not_a_real_key"))).toEqual({ status: 400, code: "bad_key", message: "Frill didn't accept this API key. Check you copied all of it, or make a new one." });
  expect(await refusal(start(["team", "contacts"]))).toMatchObject({ status: 400, code: "invalid_input", message: "Frill has no Team to bring" });
  // Only a source that can't say who saw each post asks where they come.
  expect(await refusal(call(startImport, asOwner(), { source: "canny", key: "any", parts: ["contacts", "feedback"], publicPosts: true }))).toMatchObject({
    status: 400,
    code: "invalid_input",
    message: "Canny says who may see each post: its posts come as they were",
  });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("contacts: Frill's followers as the project's users, each one of Frill's own", async () => {
  const done = await importParts(["contacts"]);
  expect(done).toMatchObject({ state: "done", error: null, counts: { contacts: { imported: 3, leftOut: {} } } });
  expect(await usersOf()).toEqual([
    { externalId: "frill:follower_juno", email: null, user: { name: "Juno Park" } },
    { externalId: "frill:follower_mira", email: "e2e-frill-mira@example.com", user: { name: "Mira Fenwick" } },
    { externalId: "frill:follower_tobias", email: "e2e-frill-tobias@example.com", user: { name: "Tobias Quill" } },
  ]);
});

test("feedback onto a Public board (the team's choice): ideas with their statuses and images, votes, comments and the team's notes; private ideas and bugs as Private; those waiting, rejected or archived left out", async () => {
  fake.fixtures.ideas.push({ ...fake.fixtures.ideas[5]!, idx: "idea_rejected", name: "Rejected idea", approval_status: "rejected", created_at: "2024-02-05T10:00:00.000Z" });
  const done = await importParts(["contacts", "feedback"], { publicPosts: true });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { name: true, postVisibility: true } })).toEqual([{ name: "Feature requests", postVisibility: "PUBLIC" }]);
  expect(done.counts).toMatchObject({
    boards: { imported: 1, leftOut: {} },
    posts: { imported: 6, leftOut: { "waiting for moderation": 1, "hidden from the portal": 2 } },
    // Each author's own vote, and three more.
    votes: { imported: 9, leftOut: {} },
    comments: { imported: 2, leftOut: { "on posts left out": 1 } },
    notes: { imported: 1, leftOut: {} },
    images: { imported: 2, leftOut: {} },
  });
  const teammate = { name: "Tara Teammate" };
  expect(await postsOf()).toEqual([
    {
      title: "Dark mode",
      body: "Night owls need it.\nEspecially <on> phones.",
      status: "COMPLETED",
      visibility: "PUBLIC",
      createdAt: new Date("2024-01-10T08:00:00.000Z"),
      voteCount: 3,
      // The new project's board, by its name.
      board: { name: "Feature requests" },
      author: { name: "Mira Fenwick" },
      comments: [{ body: "Yes please!", author: { name: "Tobias Quill" } }],
      // The note, under the teammate's name (a placeholder till they join).
      notes: [{ body: "Planning it for June.", author: teammate }],
    },
    expect.objectContaining({ title: "CSV export", status: "UNDER_REVIEW", visibility: "PUBLIC", voteCount: 2, author: { name: "Tobias Quill" }, comments: [{ body: "On our list, thanks!", author: teammate }] }),
    expect.objectContaining({ title: "Quarterly planning", status: "PLANNED", visibility: "PUBLIC", voteCount: 1, author: teammate }),
    // Private in Frill, and a bug: only their author and the team.
    expect.objectContaining({ title: "Secret plan", status: "OPEN", visibility: "PRIVATE", author: { name: "Tobias Quill" } }),
    expect.objectContaining({ title: "Crash on login", status: "IN_PROGRESS", visibility: "PRIVATE", author: { name: "Juno Park" } }),
    // A status of the team's own Tuti has no word for comes as Open; a gone author as Anonymous.
    expect.objectContaining({ title: "Keyboard shortcuts", status: "OPEN", visibility: "PUBLIC", voteCount: 1, author: { name: "Anonymous" } }),
  ]);
  // Frill's API doesn't say who's on the team: only a note's author is known to be, a placeholder of the project's
  // till they join; what they wrote in public is someone of Frill's under their name.
  const placeholders = await prisma.user.findMany({ where: { name: "Tara Teammate" }, select: { placeholderProjectId: true }, orderBy: { placeholderProjectId: "asc" } });
  expect(placeholders).toEqual([{ placeholderProjectId: project.id }, { placeholderProjectId: null }]);
  // Votes keep when they were cast.
  const tobias = await prisma.vote.findFirstOrThrow({ where: { projectId: project.id, user: { name: "Tobias Quill" }, post: { title: "Dark mode" } }, select: { createdAt: true } });
  expect(tobias.createdAt).toEqual(new Date("2024-01-15T00:00:00.000Z"));
  // Comments are asked for only on ideas Frill says have some, notes with them.
  const asked = fake.requests.filter((request) => request.startsWith("GET /v1/comments")).map((request) => new URL(request.slice(4), "http://fake").searchParams);
  expect(asked.map((query) => query.get("idea_idx"))).toEqual(["idea_dark", "idea_csv", "idea_old"]);
  expect(asked.every((query) => query.get("included_types") === "comments,notes")).toBe(true);
});

test("feedback by default onto a Private board: Frill doesn't say which ideas only some people saw, so the project's untouched board is made Private and every idea Private", async () => {
  const done = await importParts(["contacts", "feedback"]);
  expect(done.counts).toMatchObject({ boards: { imported: 1, leftOut: {} }, posts: { imported: 6 } });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: done.id }, select: { publicPosts: true } })).toEqual({ publicPosts: false });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { name: true, postVisibility: true } })).toEqual([{ name: "Feature requests", postVisibility: "PRIVATE" }]);
  expect((await postsOf()).map((post) => post.visibility)).toEqual(Array(6).fill("PRIVATE"));
});

test("a later Private import changes no board an earlier Public one brought: it stays Public, only the new ideas come Private", async () => {
  // The first import brings the first three ideas onto a Public board.
  const all = fake.fixtures.ideas;
  fake.fixtures.ideas = all.slice(0, 3);
  await importParts(["contacts", "feedback"], { publicPosts: true });
  fake.fixtures.ideas = all;
  await importParts(["contacts", "feedback"]);
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { postVisibility: true } })).toEqual([{ postVisibility: "PUBLIC" }]);
  expect((await postsOf()).map((post) => [post.title, post.visibility])).toEqual([
    ["Dark mode", "PUBLIC"],
    ["CSV export", "PUBLIC"],
    ["Quarterly planning", "PUBLIC"],
    ["Secret plan", "PRIVATE"],
    ["Crash on login", "PRIVATE"],
    ["Keyboard shortcuts", "PRIVATE"],
  ]);
});

test("the team's own board of the same name with posts of its own stays Public on a Private import, the ideas Private", async () => {
  const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  await prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 1, title: "Ours", body: "", status: "OPEN" } });
  await prisma.project.update({ where: { id: project.id }, data: { postCount: 1 } });
  await importParts(["contacts", "feedback"]);
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { postVisibility: true } })).toEqual([{ postVisibility: "PUBLIC" }]);
  expect((await postsOf()).map((post) => post.visibility)).toEqual(["PUBLIC", ...Array(6).fill("PRIVATE")]);
});

test("a Private import keeps the project's untouched board Team only when the team kept it to itself, its new name taken, its ideas Team only", async () => {
  // Another name than Frill's board: taken over (renamed), not matched by name.
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { name: "Ideas", postVisibility: "TEAM" } });
  await importParts(["contacts", "feedback"]);
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { name: true, postVisibility: true } })).toEqual([{ name: "Feature requests", postVisibility: "TEAM" }]);
  expect(new Set((await postsOf()).map((post) => post.visibility))).toEqual(new Set(["TEAM"]));
});

test("a board the team keeps to itself stays so whichever way ideas come, its posts with it", async () => {
  await prisma.board.updateMany({ where: { projectId: project.id }, data: { postVisibility: "TEAM" } });
  await importParts(["contacts", "feedback"], { publicPosts: true });
  expect(await prisma.board.findMany({ where: { projectId: project.id }, select: { postVisibility: true } })).toEqual([{ postVisibility: "TEAM" }]);
  expect(new Set((await postsOf()).map((post) => post.visibility))).toEqual(new Set(["TEAM"]));
});

test("changelog: announcements in date order, a page at a time, published at their dates and drafts as drafts, categories as tags, images, and the completed ideas they ship; nothing emailed", async () => {
  const emailed = mailbox.emails.length;
  CHANGELOG_PAGE.entries = 2;
  // A published announcement linked to an idea still under consideration: "Shipped in" would be wrong there; and one
  // scheduled for later, as a draft.
  fake.fixtures.announcements[1]!.ideas = [{ idx: "idea_csv" }];
  fake.fixtures.announcements.unshift({ idx: "announcement_later", name: "Coming next year", content_html: "<p>Soon.</p>", is_published: true, published_at: "2099-01-01T00:00:00.000Z", categories: [], ideas: [] });
  const done = await importParts(["contacts", "feedback", "changelog"]);
  expect(done.counts).toMatchObject({ changelogEntries: { imported: 4, leftOut: {} }, changelogImages: { imported: 1, leftOut: {} } });
  expect(await entriesOf()).toEqual([
    { title: "Dark mode is here", body: "Easy on the eyes at night.\nDark mode", tags: ["NEW"], publishedAt: new Date("2024-03-01T09:00:00.000Z"), posts: [{ post: { title: "Dark mode" } }] },
    { title: "Faster exports", body: "Exports take half the time.", tags: ["IMPROVED", "FIXED"], publishedAt: new Date("2024-03-10T09:00:00.000Z"), posts: [] },
    { title: "Single sign-on", body: "Coming soon.", tags: [], publishedAt: null, posts: [] },
    { title: "Coming next year", body: "Soon.", tags: [], publishedAt: null, posts: [] },
  ]);
  expect(mailbox.emails.length).toBe(emailed);
});

test("importing again brings nothing twice", async () => {
  const all = ["contacts", "feedback", "changelog", "avatars"];
  const first = await importParts(all);
  expect(importSummary(first)).toBe(
    "3 contacts, 1 board, 6 posts, 9 votes, 2 comments, 1 note, 2 images, 3 changelog entries, 1 image in the changelog, 1 profile picture brought across. Left out: 1 post hidden from the portal; 1 post waiting for moderation; 1 comment on posts left out.",
  );
  const counted = async () => Promise.all([usersOf(), postsOf(), entriesOf(), prisma.vote.count({ where: { projectId: project.id } }), prisma.media.count({ where: { projectId: project.id } })]);
  const before = await counted();
  const again = await importParts(all);
  expect(await counted()).toEqual(before);
  expect(again.counts).toMatchObject({
    contacts: { imported: 0, leftOut: { "already brought across earlier": 3 } },
    posts: { imported: 0, leftOut: { "already brought across earlier": 6 } },
    changelogEntries: { imported: 0, leftOut: { "already brought across earlier": 3 } },
  });
});
