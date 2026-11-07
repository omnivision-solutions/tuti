import { prisma } from "@tuti/db";
import { CHANGELOG_PAGE, handlers, IMPORT_KEY, importsSettled } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { type CannyFake, cannyFixtures, FAKE_CANNY_KEY, type S3Fake, startCannyFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports from Canny (docs/plan.md, Import from Canny), against the Canny and S3 fakes. */

let fake: CannyFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startCannyFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
const limits = { ...CHANGELOG_PAGE };
afterEach(() => void Object.assign(CHANGELOG_PAGE, limits));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...fake.env, ...s3.env, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
    vi.stubEnv(name, value);
  }
  // Two to a page, so every list takes several.
  Object.assign(fake, { fixtures: cannyFixtures(), pageSize: 2 });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (parts: string[], key = FAKE_CANNY_KEY) => call(startImport, asOwner(), { source: "canny", key, parts: parts as never });
async function importParts(parts: string[]) {
  await start(parts);
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));

const usersOf = () =>
  prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, email: true, properties: true, user: { select: { name: true } } } });
const postsOf = () =>
  prisma.post.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: {
      title: true,
      body: true,
      status: true,
      eta: true,
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
    select: { title: true, body: true, tags: true, publishedAt: true, coverId: true, posts: { select: { post: { select: { title: true } } } } },
  });

test("a key Canny refuses is refused, nothing started; Canny has no team, help center or inbox to bring", async () => {
  expect(await refusal(start(["contacts"], "not_a_real_key"))).toEqual({ status: 400, code: "bad_key", message: "Canny didn't accept this API key. Check you copied all of it, or make a new one." });
  expect(await refusal(start(["team", "contacts"]))).toMatchObject({ status: 400, code: "invalid_input", message: "Canny has no Team to bring" });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("contacts: Canny's users (not its admins) as the project's users, with their app's id, custom fields and company", async () => {
  const done = await importParts(["contacts"]);
  expect(done).toMatchObject({ state: "done", error: null, counts: { contacts: { imported: 3, leftOut: {} } } });
  expect(await usersOf()).toEqual([
    { externalId: "app-mira", email: "e2e-canny-mira@example.com", properties: { company: "Acme Labs", plan: "Pro" }, user: { name: "Mira Fenwick" } },
    // Without an id in the team's app: one of Canny's own.
    { externalId: "canny:c0000000000000000000u002", email: "e2e-canny-tobias@example.com", properties: {}, user: { name: "Tobias Quill" } },
    { externalId: "canny:c0000000000000000000u003", email: null, properties: {}, user: { name: "Juno Park" } },
  ]);
});

test("feedback: boards, posts with their statuses, public ETA and images, votes, comments and the team's internal ones as notes; a private board's left out", async () => {
  const done = await importParts(["contacts", "feedback"]);
  expect(done.counts).toMatchObject({
    boards: { imported: 1, leftOut: { "only some people see": 1 } },
    posts: { imported: 4, leftOut: { "only some people see": 1 } },
    // Each author's own vote, and three more; one by a voter Canny has deleted isn't brought.
    votes: { imported: 7, leftOut: {} },
    comments: { imported: 2, leftOut: { "on posts left out": 1, "private but not by the team": 1 } },
    notes: { imported: 1, leftOut: {} },
    images: { imported: 2, leftOut: {} },
  });
  const team = { name: "Olive Owner" };
  expect(await postsOf()).toEqual([
    {
      title: "Dark mode",
      body: "Night owls need it.\nEspecially <on> phones.",
      status: "COMPLETED",
      eta: new Date("2024-06-01T00:00:00.000Z"),
      createdAt: new Date("2024-01-10T08:00:00.000Z"),
      voteCount: 3,
      // The new project's board, by its name.
      board: { name: "Feature requests" },
      author: { name: "Mira Fenwick" },
      comments: [{ body: "Yes please!", author: { name: "Tobias Quill" } }],
      // The admin's internal comment, as the team's note under their name (a placeholder till they join).
      notes: [{ body: "Planning it for June.", author: team }],
    },
    expect.objectContaining({ title: "CSV export", status: "UNDER_REVIEW", voteCount: 2, author: { name: "Tobias Quill" }, comments: [{ body: "On our list, thanks!", author: team }] }),
    // Its ETA was the team's alone in Canny: Tuti's portal would show it, so it stays out.
    expect.objectContaining({ title: "Quarterly planning", status: "PLANNED", eta: null, voteCount: 1, author: team }),
    // A status of the team's own comes as Open; a deleted author as Anonymous.
    expect.objectContaining({ title: "Keyboard shortcuts", status: "OPEN", voteCount: 1, author: { name: "Anonymous" } }),
  ]);
  // Votes keep when they were cast.
  const tobias = await prisma.vote.findFirstOrThrow({ where: { projectId: project.id, user: { name: "Tobias Quill" }, post: { title: "Dark mode" } }, select: { createdAt: true } });
  expect(tobias.createdAt).toEqual(new Date("2024-01-15T00:00:00.000Z"));
});

test("changelog: entries in date order, a page at a time, published at their dates and drafts as drafts, types as tags, images, and the completed posts they ship; nothing emailed", async () => {
  const emailed = mailbox.emails.length;
  // Two to a page, so Canny's list is read in slices.
  CHANGELOG_PAGE.entries = 2;
  // A published entry linked to a post still under review: "Shipped in" would be wrong there.
  fake.fixtures.entries[1]!.posts = [{ id: "c0000000000000000000p002" }];
  const done = await importParts(["contacts", "feedback", "changelog"]);
  expect(done.counts).toMatchObject({ changelogEntries: { imported: 3, leftOut: {} }, changelogImages: { imported: 1, leftOut: {} } });
  expect(await entriesOf()).toEqual([
    { title: "Dark mode is here", body: "Easy on the eyes at night.\nDark mode", tags: ["NEW"], publishedAt: new Date("2024-03-01T09:00:00.000Z"), coverId: null, posts: [{ post: { title: "Dark mode" } }] },
    { title: "Faster exports", body: "Exports take half the time.", tags: ["IMPROVED", "FIXED"], publishedAt: new Date("2024-03-10T09:00:00.000Z"), coverId: null, posts: [] },
    { title: "Single sign-on", body: "Coming soon.", tags: [], publishedAt: null, coverId: null, posts: [] },
  ]);
  expect(mailbox.emails.length).toBe(emailed);
});

test("importing again brings nothing twice", async () => {
  const all = ["contacts", "feedback", "changelog", "avatars"];
  const first = await importParts(all);
  expect(importSummary(first)).toBe(
    "3 contacts, 1 board, 4 posts, 7 votes, 2 comments, 1 note, 2 images, 3 changelog entries, 1 image in the changelog, 1 profile picture brought across. Left out: 1 board only some people see; 1 post only some people see; 1 comment on posts left out; 1 comment private but not by the team.",
  );
  const counted = async () => Promise.all([usersOf(), postsOf(), entriesOf(), prisma.vote.count({ where: { projectId: project.id } }), prisma.media.count({ where: { projectId: project.id } })]);
  const before = await counted();
  const again = await importParts(all);
  expect(await counted()).toEqual(before);
  expect(again.counts).toMatchObject({
    contacts: { imported: 0, leftOut: { "already brought across earlier": 3 } },
    posts: { imported: 0, leftOut: { "already brought across earlier": 4 } },
    changelogEntries: { imported: 0, leftOut: { "already brought across earlier": 3 } },
  });
});

test("Feedback imported after the changelog links its posts to the drafts that ship them, never to a published entry, changes no post, and never links again what the team took off", async () => {
  // The draft ships a post too.
  fake.fixtures.entries[0]!.posts = [{ id: "c0000000000000000000p002" }];
  await importParts(["contacts", "changelog"]);
  expect((await entriesOf()).map((entry) => entry.posts)).toEqual([[], [], []]);
  await importParts(["contacts", "feedback", "changelog"]);
  const [published, , draft] = await entriesOf();
  // Published: its posts are the ones its publishing completed, as the app keeps them (Unpublish to change them).
  expect(published!.posts).toEqual([]);
  // A draft: linked, so publishing it completes the post, as any draft's.
  expect(draft!.posts).toEqual([{ post: { title: "CSV export" } }]);
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id, title: "CSV export" }, select: { status: true } })).toEqual({ status: "UNDER_REVIEW" });
  expect(await prisma.postEvent.count({ where: { post: { projectId: project.id }, changelogEntryId: { not: null } } })).toBe(0);

  // The team takes the link off the draft: another import leaves it off.
  await prisma.changelogEntryPost.deleteMany({ where: { entry: { projectId: project.id, title: "Single sign-on" } } });
  await importParts(["contacts", "feedback", "changelog"]);
  expect((await entriesOf())[2]!.posts).toEqual([]);
});

test("an import from a source this worker doesn't know (a newer web started it mid-deploy) fails, its key cleared, saying why, though its row can't be read", async () => {
  // A source this release's client has no enum value for, as the previous release's worker sees a new one.
  await prisma.$executeRawUnsafe(`ALTER TYPE "ImportSource" ADD VALUE IF NOT EXISTS 'FROM_THE_FUTURE'`);
  const id = "import-from-the-future";
  await prisma.$executeRaw`
    INSERT INTO data_import (id, "projectId", source, "startedById", "apiKey", parts, step)
    VALUES (${id}, ${project.id}, 'FROM_THE_FUTURE', ${owner.id}, ${sealValue(IMPORT_KEY, FAKE_CANNY_KEY)}, ARRAY['contacts'], 'contacts')`;
  // The client can't read it.
  await expect(prisma.dataImport.findUnique({ where: { id } })).rejects.toThrow();
  expect(await handlers.importStep({ importId: id }, { info: () => {}, warn: () => {} })).toEqual({ failed: true });
  expect(await prisma.$queryRaw`SELECT state::text AS state, "apiKey", error FROM data_import WHERE id = ${id}`).toEqual([
    { state: "FAILED", apiKey: null, error: "Tuti was updating as it started. Start it again to go on: what came across already is skipped." },
  ]);
  await prisma.$executeRaw`DELETE FROM data_import WHERE id = ${id}`;
});
