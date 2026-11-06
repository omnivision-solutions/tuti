import { prisma } from "@tuti/db";
import { CHANGELOG_PAGE, handlers, importsSettled } from "@tuti/jobs";
import { FAKE_FEATUREBASE_KEY, type FeaturebaseFake, featurebaseFixtures, type S3Fake, startFeaturebaseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports' changelog (docs/plan.md, Switching from Featurebase), against the Featurebase and S3 fakes. */

let fake: FeaturebaseFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startFeaturebaseFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
const limits = { ...CHANGELOG_PAGE };
afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(CHANGELOG_PAGE, limits);
});
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...fake.env, ...s3.env, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
    vi.stubEnv(name, value);
  }
  // A few to a page, so the list takes several.
  Object.assign(fake, { fixtures: featurebaseFixtures(), pageSize: 2 });
  fake.forbidden.clear();
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
async function importChangelog() {
  await call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["changelog"] });
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const entries = () =>
  prisma.changelogEntry.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: { number: true, title: true, body: true, content: true, tags: true, publishedAt: true, announced: true, coverId: true, subscribersEmailedAt: true, subscribersEmailDueAt: true, createdById: true },
  });

test("the changelog comes across quietly: entries everyone sees in date order, published at their dates and drafts as drafts, with their images, cover and tags; those only some people see, or too long, left out; comments counted", async () => {
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email: "e2e-reader@example.com", token: "t", confirmedAt: new Date() } });
  const emailed = mailbox.emails.length;
  const done = await importChangelog();

  expect(done).toMatchObject({ state: "done", error: null });
  expect(done.counts).toEqual({
    changelogEntries: { imported: 3, leftOut: { "only some people see": 2, "longer than 20,000 characters, Tuti's most": 1 } },
    // The entry's image and its cover.
    changelogImages: { imported: 2, leftOut: {} },
    changelogComments: { imported: 0, leftOut: { "(Tuti's changelog has no comments)": 2 } },
  });
  expect(importSummary(done)).toBe("3 changelog entries, 2 images in the changelog brought across. Left out: 2 changelog entries only some people see; 1 changelog entry longer than 20,000 characters, Tuti's most; 2 comments on the changelog (Tuti's changelog has no comments).");

  const [dark, exports, sso, ...rest] = await entries();
  expect(rest).toEqual([]);
  // Emailed in Featurebase: marked so here, so publishing it again doesn't email it twice. Never announced, nothing due.
  expect(dark).toMatchObject({
    number: 1,
    title: "Dark mode is here",
    body: expect.stringContaining("Easy on the eyes at night."),
    tags: ["NEW"],
    publishedAt: new Date("2024-02-01T09:00:00.000Z"),
    subscribersEmailedAt: new Date("2024-02-01T09:00:00.000Z"),
    subscribersEmailDueAt: null,
    announced: false,
    createdById: owner.id,
  });
  expect(dark!.coverId).not.toBeNull();
  // Its image and cover copied into the project's media, the image in its content.
  expect(JSON.stringify(dark!.content)).toContain('"type":"image"');
  expect(await prisma.media.count({ where: { projectId: project.id, status: "READY" } })).toBe(2);
  expect(exports).toMatchObject({ number: 2, title: "Faster exports", tags: ["IMPROVED"], publishedAt: new Date("2024-03-01T09:00:00.000Z"), subscribersEmailedAt: null });
  // Emailed, then unpublished in Featurebase: still marked emailed.
  expect(sso).toMatchObject({ number: 3, title: "Single sign-on", tags: [], publishedAt: null, subscribersEmailedAt: new Date("2024-03-05T09:00:00.000Z") });
  expect(mailbox.emails.length).toBe(emailed);
  // Those Featurebase emailed are marked so (their sidebar says so); one Tuti emails later isn't.
  const marked = await prisma.importedRecord.findMany({ where: { projectId: project.id, kind: "changelog-emailed" }, select: { localId: true } });
  const ids = Object.fromEntries((await prisma.changelogEntry.findMany({ where: { projectId: project.id }, select: { id: true, title: true } })).map((entry) => [entry.id, entry.title]));
  expect(marked.map((record) => ids[record.localId]).sort()).toEqual(["Dark mode is here", "Single sign-on"]);
});

test("importing again brings nothing twice", async () => {
  await importChangelog();
  const before = await entries();
  const again = await importChangelog();
  expect(await entries()).toEqual(before);
  expect(again.counts.changelogEntries).toEqual({ imported: 0, leftOut: { "already brought across earlier": 3, "only some people see": 2, "longer than 20,000 characters, Tuti's most": 1 } });
});

test("a page's images begun past its time limit are left out, counted; the entries come across", async () => {
  CHANGELOG_PAGE.hardMs = -1;
  const done = await importChangelog();
  expect(done.counts.changelogEntries!.imported).toBe(3);
  expect(done.counts.changelogImages).toEqual({ imported: 0, leftOut: { "that couldn't be fetched": 2 } });
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(0);
});

test("past a page's soft limit the rest of its entries are the next page's, every one arriving with its images", async () => {
  // A clock that moves on each look: once a page has done an entry, it's past its soft limit.
  let now = 0;
  Object.assign(CHANGELOG_PAGE, { softMs: 0, now: () => ++now });
  const done = await importChangelog();
  expect(done.counts.changelogEntries).toEqual({ imported: 3, leftOut: { "only some people see": 2, "longer than 20,000 characters, Tuti's most": 1 } });
  expect(done.counts.changelogImages).toEqual({ imported: 2, leftOut: {} });
  expect((await entries()).map((entry) => entry.title)).toEqual(["Dark mode is here", "Faster exports", "Single sign-on"]);
});

test("a page cut short goes on after the last entry done, even when one before it is gone from Featurebase meanwhile", async () => {
  // One entry a page; after the first page, the oldest is deleted in Featurebase, so the list shifts up by one.
  let now = 0;
  Object.assign(CHANGELOG_PAGE, { softMs: 0, now: () => ++now });
  const importStep = handlers.importStep;
  let cut = false;
  handlers.importStep = async (input, log) => {
    // Before the second page (pages run one inside another, inline).
    const { cursor } = await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } });
    if (cursor && !cut) {
      cut = true;
      fake.fixtures.changelogs = fake.fixtures.changelogs.filter((entry) => entry.title !== "Dark mode is here");
    }
    return importStep(input, log);
  };
  try {
    await importChangelog();
  } finally {
    handlers.importStep = importStep;
  }
  expect((await entries()).map((entry) => entry.title)).toEqual(["Dark mode is here", "Faster exports", "Single sign-on"]);
});

test("a page cut short whose last entry is gone meanwhile goes on from its date: another of the same date still comes", async () => {
  const [first, second] = ["Dark mode is here", "Faster exports"].map((title) => fake.fixtures.changelogs.find((entry) => entry.title === title)!);
  second!.date = first!.date;
  let now = 0;
  Object.assign(CHANGELOG_PAGE, { softMs: 0, now: () => ++now });
  const importStep = handlers.importStep;
  let cut = false;
  handlers.importStep = async (input, log) => {
    // Before the next page: the last one done, where it goes on from, is deleted in Featurebase.
    const { cursor } = await prisma.dataImport.findUniqueOrThrow({ where: { id: input.importId } });
    const after = cursor && (JSON.parse(cursor) as { after: { id: string } | null }).after;
    if (after && !cut) {
      cut = true;
      fake.fixtures.changelogs = fake.fixtures.changelogs.filter((entry) => entry.id !== after.id);
    }
    return importStep(input, log);
  };
  try {
    await importChangelog();
  } finally {
    handlers.importStep = importStep;
  }
  expect((await entries()).map((entry) => entry.title).sort()).toEqual(["Dark mode is here", "Faster exports", "Single sign-on"]);
});

test("a cover that's also in the entry's text, signed apart, is copied once", async () => {
  const dark = fake.fixtures.changelogs.find((entry) => entry.title === "Dark mode is here")!;
  Object.assign(dark, { featuredImage: `${fake.url}/files/shot.png?X-Amz-Signature=a`, content: `<p><img src="${fake.url}/files/shot.png?X-Amz-Signature=b" alt="Dark mode"></p>` });
  const done = await importChangelog();
  expect(done.counts.changelogImages).toEqual({ imported: 1, leftOut: {} });
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(1);
});

test("a cover that's also in the text and can't be copied is counted left out once", async () => {
  const dark = fake.fixtures.changelogs.find((entry) => entry.title === "Dark mode is here")!;
  Object.assign(dark, { featuredImage: `${fake.url}/files/gone.png?X-Amz-Signature=a`, content: `<p><img src="${fake.url}/files/gone.png?X-Amz-Signature=b" alt="Gone"></p>` });
  const done = await importChangelog();
  expect(done.counts.changelogImages).toEqual({ imported: 0, leftOut: { "that couldn't be fetched": 1 } });
});

test("a key that can't read the changelog isn't accepted for it", async () => {
  fake.forbidden.add("/v2/changelogs");
  await expect(call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["changelog"] })).rejects.toMatchObject({
    status: 400,
    code: "cant_read",
    message: "This key can't read Changelog in Featurebase. Use a key that can, or leave Changelog out.",
  });
});
