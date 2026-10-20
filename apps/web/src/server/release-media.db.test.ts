import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { attachMedia } from "@/server/content";
import { createUpload } from "@/server/media";
import { createChangelogEntry } from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { createArticle, deleteArticle, updateArticle } from "@/server/operations/help";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** The `release-media` job: uploads no content uses any more are released, then deleted by `cleanup-media`. */

let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());

beforeEach(async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
});
afterEach(() => vi.unstubAllEnvs());

const quiet = { info: () => {}, warn: () => {} };
/** Runs the job; returns how many uploads it released (in any project: the file's tests share a database). */
const release = async () => (await handlers.releaseMedia({}, quiet)).released;
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const as = (user: TestUser, projectId = project.id) => ({ actor: { kind: "user" as const, userId: user.id }, projectId });

/** A finished upload, uploaded two days ago. */
const upload = (projectId = project.id, size = 10) =>
  prisma.media.create({
    data: { projectId, uploaderId: owner.id, size, status: "READY", width: 480, height: 320, createdAt: daysAgo(2) },
  });
const image = (mediaId: string) => ({ type: "image", attrs: { mediaId, width: "100", align: "center", alt: "", w: 480, h: 320 } });
const doc = (...mediaIds: string[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "See below." }] }, ...mediaIds.map(image)],
});
/** As if the content using them was last saved two days ago. */
const ageAttachments = () =>
  prisma.media.updateMany({ where: { projectId: project.id, attachedAt: { not: null } }, data: { attachedAt: daysAgo(2) } });
const attached = async (...ids: string[]) =>
  (await prisma.media.findMany({ where: { id: { in: ids } }, select: { attachedAt: true } })).map((m) => m.attachedAt !== null);
const post = (title: string, ...mediaIds: string[]) =>
  call(createPost, as(owner), { board: "feature-requests", title, content: doc(...mediaIds) });
const postId = async (number: number) => (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number } })).id;

test("an upload only a deleted post or comment used is released; one that other content uses, of any kind, is kept", async () => {
  const [inPost, inComment, alsoInChangelog] = [await upload(), await upload(), await upload()];
  const deleted = await post("Screenshots", inPost.id, alsoInChangelog.id);
  const kept = await post("Another post");
  // Comments can't have images yet; one with an image, as a save will store it once they can.
  await prisma.comment.create({
    data: { projectId: project.id, postId: await postId(kept.number), authorId: owner.id, body: "", content: doc(inComment.id) },
  });
  await prisma.media.update({ where: { id: inComment.id }, data: { attachedAt: new Date() } });
  await call(createChangelogEntry, as(owner), { title: "Screenshots", content: doc(alsoInChangelog.id) });
  await ageAttachments();

  expect(await release()).toBe(0);

  await prisma.post.delete({ where: { id: await postId(deleted.number) } });
  await prisma.comment.deleteMany({ where: { projectId: project.id } });
  expect(await release()).toBe(2);
  expect(await attached(inPost.id)).toEqual([false]);
  expect(await attached(inComment.id)).toEqual([false]);
  expect(await attached(alsoInChangelog.id)).toEqual([true]);
});

test("an image edited out of content less than a day ago stays attached for now", async () => {
  const photo = await upload();
  const saved = await post("Screenshot", photo.id);
  await prisma.post.delete({ where: { id: await postId(saved.number) } });

  expect(await release()).toBe(0);
  await ageAttachments();
  expect(await release()).toBe(1);
});

test("an article's uploads are kept while an old revision or the deleted article uses them, and released once it's purged", async () => {
  const [first, second] = [await upload(), await upload()];
  await call(createArticle, as(owner), { title: "Billing", content: doc(first.id) });
  // The current version uses only `second`; the first revision still uses `first`.
  await call(updateArticle, as(owner), { slug: "billing", content: doc(second.id) });
  await ageAttachments();
  expect(await release()).toBe(0);

  // Deleted, but restorable for 30 days.
  await call(deleteArticle, as(owner), { slug: "billing" });
  expect(await release()).toBe(0);
  expect(await attached(first.id, second.id)).toEqual([true, true]);

  await prisma.article.updateMany({ where: { projectId: project.id }, data: { deletedAt: daysAgo(31) } });
  await handlers.purgeArticles({}, quiet);
  expect(await release()).toBe(2);
  expect(await attached(first.id, second.id)).toEqual([false, false]);
});

test("an article's own content keeps its uploads, even without a revision", async () => {
  const photo = await upload();
  await prisma.article.create({ data: { projectId: project.id, slug: "setup", title: "Setup", content: doc(photo.id) } });
  await prisma.media.update({ where: { id: photo.id }, data: { attachedAt: daysAgo(2) } });
  expect(await release()).toBe(0);
});

test("one project's content doesn't keep another project's uploads, and their own content does", async () => {
  const other = await createProject(owner);
  const [used, unused] = [await upload(other.id), await upload(other.id)];
  const board = other.boards[0]!.id;
  await prisma.post.create({ data: { projectId: other.id, boardId: board, authorId: owner.id, number: 1, title: "Theirs", content: doc(used.id) } });
  // This project's content names the other project's upload (saves refuse that; this checks the release doesn't rely on it).
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 1, title: "Ours", content: doc(unused.id) } });
  await prisma.media.updateMany({ where: { projectId: other.id }, data: { attachedAt: daysAgo(2) } });

  expect(await release()).toBe(1);
  expect(await attached(used.id, unused.id)).toEqual([true, false]);
});

describe("a save racing the release", () => {
  test("a save that attached the upload before the release reached it keeps it", async () => {
    const photo = await upload();
    await prisma.media.update({ where: { id: photo.id }, data: { attachedAt: daysAgo(2) } });

    let releasing: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.post.create({
        data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Racing", content: doc(photo.id) },
      });
      await attachMedia(tx, project.id, [photo.id]);
      // The release doesn't see the uncommitted post, and waits for the upload's row.
      releasing = release();
      await waitForLockWait();
    });
    expect(await releasing).toBe(0);
    expect(await attached(photo.id)).toEqual([true]);
  });

  test("a save that attaches the upload after the release took it keeps it", async () => {
    const photo = await upload();
    await prisma.media.update({ where: { id: photo.id }, data: { attachedAt: daysAgo(2) } });

    await prisma.$transaction(async (tx) => {
      await tx.post.create({
        data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Racing", content: doc(photo.id) },
      });
      expect(await release()).toBe(1);
      await attachMedia(tx, project.id, [photo.id]);
    });
    expect(await attached(photo.id)).toEqual([true]);
  });
});

test("the quota frees once a released upload is cleaned up", async () => {
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "1");
  actAs(owner);
  const big = await upload(project.id, 1024 * 1024 - 100);
  const saved = await post("Big screenshot", big.id);
  expect(await createUpload(project.slug, { type: "image/png", size: 1000 })).toEqual({ error: "This project has no space left for images" });

  await prisma.post.delete({ where: { id: await postId(saved.number) } });
  await ageAttachments();
  await release();
  await handlers.cleanupMedia({}, quiet);
  expect(await prisma.media.count({ where: { id: big.id } })).toBe(0);
  expect(await createUpload(project.slug, { type: "image/png", size: 1000 })).toEqual({ mediaId: expect.any(String), uploadUrl: expect.any(String) });
});

test("thousands of rows: one release over a project's content", async () => {
  const media = await prisma.media.createManyAndReturn({
    data: Array.from({ length: 1500 }, () => ({ projectId: project.id, uploaderId: owner.id, size: 10, status: "READY" as const, attachedAt: daysAgo(2) })),
    select: { id: true },
  });
  const used = media.slice(0, 1000);
  const board = project.boards[0]!.id;
  await prisma.post.createMany({
    data: Array.from({ length: 3000 }, (_, i) => ({
      projectId: project.id,
      boardId: board,
      authorId: owner.id,
      number: i + 1,
      title: `Post ${i + 1}`,
      content: i % 3 === 0 ? doc(used[i / 3]!.id) : doc(),
    })),
  });
  const posts = await prisma.post.findMany({ where: { projectId: project.id }, select: { id: true }, take: 2000 });
  await prisma.comment.createMany({
    data: posts.map((p) => ({ projectId: project.id, postId: p.id, authorId: owner.id, body: "", content: doc() })),
  });

  // The time is logged, not asserted: a busy CI machine mustn't fail a correct release.
  const started = performance.now();
  expect(await release()).toBe(500);
  console.info(`release-media: 1,500 uploads, 3,000 posts and 2,000 comments in ${Math.round(performance.now() - started)} ms`);
  expect(await prisma.media.count({ where: { id: { in: used.map((m) => m.id) }, attachedAt: null } })).toBe(0);
});

/** Waits until some query in this database is waiting for a lock. */
async function waitForLockWait() {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The release never waited for the save");
}
