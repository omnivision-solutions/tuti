import { emailImageKey, imageKey, mediaKeys, originalKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { createUpload, finishUpload, uploadStatus } from "./media";
import { createPost } from "./posts";

let s3: S3Fake;
let owner: TestUser;
let ada: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());

beforeEach(async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
  ada = await signUp("Ada"); // a portal user: not on the team
  actAs(ada);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;

/** A JPEG photo, `width`×`height`, with GPS coordinates in its EXIF data. */
function photo(width: number, height: number, orientation?: number) {
  let image = sharp({ create: { width, height, channels: 3, background: "#3a7" } })
    .withExif({ IFD0: { Artist: "Ada" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .jpeg();
  if (orientation) {
    image = image.withMetadata({ orientation });
  }
  return image.toBuffer();
}

/** Uploads like the browser does: ask for a URL, PUT the file, say it's done. */
async function upload(file: Buffer, type = "image/jpeg") {
  const created = await createUpload(project.slug, { type, size: file.length });
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(file), headers: { "content-type": type } });
  expect(put.ok).toBe(true);
  const finished = await finishUpload(created.mediaId);
  return { ...finished, mediaId: created.mediaId };
}

describe("processing", () => {
  test("a photo is re-encoded to WebP sizes and an email JPEG, without its metadata, and the original is deleted", async () => {
    const original = await photo(3000, 2000);
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const result = await upload(original);
    expect(result).toEqual({ mediaId: expect.any(String) });
    const id = (result as { mediaId: string }).mediaId;

    const keys = [480, 960, 1600, 2400].map((w) => imageKey(id, w));
    const status = await uploadStatus(id);
    expect(status).toMatchObject({ status: "READY", width: 2400, height: 1600 });
    const { src, urls } = status as { src: string; urls: Record<string, string> };
    expect(Object.keys(urls).sort()).toEqual([...keys, emailImageKey(id)].sort());
    expect(src).toBe(urls[imageKey(id, 2400)]);
    // The bucket is private: the signed URL reads the file, its bare address doesn't.
    expect(new URL(src).searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect((await fetch(src)).status).toBe(200);
    expect((await fetch(src.split("?")[0]!)).status).toBe(403);
    const stored = [...s3.objects.keys()].filter((key) => key.includes(id));
    expect(stored.sort()).toEqual([...keys, emailImageKey(id)].sort());

    for (const key of keys) {
      const meta = await sharp(s3.objects.get(key)!.body).metadata();
      expect(meta).toMatchObject({ format: "webp", width: Number(/(\d+)\.webp$/.exec(key)![1]) });
      expect(meta.exif).toBeUndefined();
    }
    const email = await sharp(s3.objects.get(emailImageKey(id))!.body).metadata();
    expect(email).toMatchObject({ format: "jpeg", width: 1200 });
    expect(email.exif).toBeUndefined();
    expect(s3.objects.has(originalKey(id))).toBe(false);

    const media = await prisma.media.findUniqueOrThrow({ where: { id } });
    const bytes = stored.reduce((sum, key) => sum + s3.objects.get(key)!.body.length, 0);
    expect(media).toMatchObject({ status: "READY", width: 2400, height: 1600, size: bytes });
  });

  test("photos taken sideways are turned upright; small images aren't enlarged", async () => {
    const sideways = (await upload(await photo(400, 300, 6))) as { mediaId: string };
    expect(await uploadStatus(sideways.mediaId)).toMatchObject({ width: 300, height: 400 });
    expect(s3.objects.has(imageKey(sideways.mediaId, 300))).toBe(true);
    expect(s3.objects.has(imageKey(sideways.mediaId, 480))).toBe(false);
  });

  test("files are checked by content: an SVG sent as a PNG is refused and deleted", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const result = (await upload(svg, "image/png")) as { mediaId: string };
    expect(await uploadStatus(result.mediaId)).toEqual({ status: "FAILED" });
    expect([...s3.objects.keys()].filter((key) => key.includes(result.mediaId))).toEqual([]);
    expect(await prisma.media.findUniqueOrThrow({ where: { id: result.mediaId } })).toMatchObject({ size: 0 });
  });

  test("something that isn't an image at all is refused", async () => {
    const result = (await upload(Buffer.from("just text, not a picture"), "image/jpeg")) as { mediaId: string };
    expect(await uploadStatus(result.mediaId)).toEqual({ status: "FAILED" });
  });
});

describe("limits", () => {
  test("only JPEG, PNG, WebP and GIF; never SVG", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf"]) {
      expect(await createUpload(project.slug, { type, size: 1000 })).toEqual({
        error: "Only JPEG, PNG, WebP and GIF images can be uploaded",
      });
    }
  });

  test("portal users get 5 MB per image, the team 10 MB", async () => {
    expect(await createUpload(project.slug, { type: "image/png", size: 5 * MB + 1 })).toEqual({
      error: "Images can be up to 5 MB",
    });
    actAs(owner);
    expect(await createUpload(project.slug, { type: "image/png", size: 5 * MB + 1 })).toMatchObject({ mediaId: expect.any(String) });
    expect(await createUpload(project.slug, { type: "image/png", size: 10 * MB + 1 })).toEqual({
      error: "Images can be up to 10 MB",
    });
  });

  test("limits can be changed with env vars", async () => {
    vi.stubEnv("MEDIA_MAX_IMAGE_MB_USER", "1");
    expect(await createUpload(project.slug, { type: "image/png", size: MB + 1 })).toEqual({ error: "Images can be up to 1 MB" });
  });

  test("a project's images share a quota", async () => {
    vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "1");
    const member = await addMember(project.id, "MEMBER");
    actAs(member);
    expect(await createUpload(project.slug, { type: "image/png", size: 600 * 1024 })).toMatchObject({ mediaId: expect.any(String) });
    expect(await createUpload(project.slug, { type: "image/png", size: 600 * 1024 })).toEqual({
      error: "This project has no space left for images",
    });
    // Failed uploads give their space back.
    await prisma.media.updateMany({ where: { projectId: project.id }, data: { status: "FAILED", size: 0 } });
    expect(await createUpload(project.slug, { type: "image/png", size: 600 * 1024 })).toMatchObject({ mediaId: expect.any(String) });
  });

  test("each person can start 30 uploads an hour", async () => {
    await prisma.media.createMany({
      data: Array.from({ length: 30 }, () => ({ projectId: project.id, uploaderId: ada.id, size: 1, status: "FAILED" as const })),
    });
    expect(await createUpload(project.slug, { type: "image/png", size: 1000 })).toEqual({
      error: "You've uploaded a lot of images in the last hour. Try again later.",
    });
  });

  test("without media storage, uploads are off", async () => {
    vi.stubEnv("MEDIA_S3_ENDPOINT", "");
    expect(await createUpload(project.slug, { type: "image/png", size: 1000 })).toEqual({
      error: "Image uploads aren't set up on this server",
    });
  });
});

describe("finishing", () => {
  test("an upload that never arrived, or arrived with another size, isn't processed", async () => {
    const file = await photo(100, 100);
    const missing = await createUpload(project.slug, { type: "image/jpeg", size: file.length });
    expect(await finishUpload((missing as { mediaId: string }).mediaId)).toEqual({ error: "The upload didn't arrive. Try again." });

    const created = (await createUpload(project.slug, { type: "image/jpeg", size: file.length })) as { mediaId: string; uploadUrl: string };
    await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(Buffer.concat([file, file])) });
    expect(await finishUpload(created.mediaId)).toEqual({ error: "The upload didn't match the file. Try again." });
    expect(s3.objects.has(originalKey(created.mediaId))).toBe(false);
    expect(await uploadStatus(created.mediaId)).toEqual({ status: "FAILED" });
  });

  test("only the uploader can finish an upload or see its status", async () => {
    const file = await photo(100, 100);
    const created = (await createUpload(project.slug, { type: "image/jpeg", size: file.length })) as { mediaId: string; uploadUrl: string };
    await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(file) });

    actAs(owner);
    expect(await finishUpload(created.mediaId)).toEqual({ error: "Upload not found" });
    expect(await uploadStatus(created.mediaId)).toEqual({ error: "Upload not found" });
    actAs(ada);
    expect(await finishUpload(created.mediaId)).toEqual({});
    expect(await finishUpload(created.mediaId)).toEqual({ error: "Upload not found" }); // only once
  });
});

describe("cleanup", () => {
  const day = 24 * 60 * 60 * 1000;

  test("uploads no saved content uses are deleted after a day, with their files", async () => {
    const media = (fields: { attachedAt?: Date; createdAt: Date }) =>
      prisma.media.create({
        data: { projectId: project.id, uploaderId: ada.id, size: 10, status: "READY", width: 1200, height: 800, ...fields },
      });
    const [unused, used, recent] = await Promise.all([
      media({ createdAt: new Date(Date.now() - day - 60_000) }),
      media({ createdAt: new Date(Date.now() - 2 * day), attachedAt: new Date(Date.now() - day) }),
      media({ createdAt: new Date(Date.now() - day + 60_000) }),
    ]);
    for (const m of [unused, used, recent]) {
      for (const key of mediaKeys(m)) {
        s3.objects.set(key, { body: Buffer.from("x"), contentType: "image/webp" });
      }
    }

    const log = { info: () => {}, warn: () => {} };
    expect(await handlers.cleanupMedia({}, log)).toEqual({ deleted: 1, unsentAttachments: 0, failedFiles: 0 });

    const left = await prisma.media.findMany({ where: { projectId: project.id }, select: { id: true } });
    expect(left.map((m) => m.id).sort()).toEqual([used.id, recent.id].sort());
    expect(mediaKeys(unused).filter((key) => s3.objects.has(key))).toEqual([]);
    expect(mediaKeys(used).every((key) => s3.objects.has(key))).toBe(true);
  });

  test("a file that can't be deleted doesn't hold up the others", async () => {
    const old = () =>
      prisma.media.create({
        data: { projectId: project.id, uploaderId: ada.id, size: 10, width: 480, createdAt: new Date(Date.now() - 2 * day) },
      });
    const [stuck, fine] = [await old(), await old()];
    for (const m of [stuck, fine]) {
      for (const key of mediaKeys(m)) {
        s3.objects.set(key, { body: Buffer.from("x"), contentType: "image/webp" });
      }
    }
    s3.failDeletes.add(imageKey(stuck.id, 480));

    expect(await handlers.cleanupMedia({}, { info: () => {}, warn: () => {} })).toEqual({ deleted: 2, unsentAttachments: 0, failedFiles: 1 });
    expect(mediaKeys(fine).filter((key) => s3.objects.has(key))).toEqual([]);
    expect(await prisma.media.count({ where: { id: { in: [stuck.id, fine.id] } } })).toBe(0);
  });

  test("an upload claimed by the cleanup can't be used by a post saved afterwards", async () => {
    const old = await prisma.media.create({
      data: { projectId: project.id, uploaderId: ada.id, size: 10, status: "READY", width: 480, height: 320, createdAt: new Date(Date.now() - 2 * day) },
    });
    // The post's content was checked while the upload still existed…
    const form = new FormData();
    form.set("projectSlug", project.slug);
    form.set("boardSlug", "feature-requests");
    form.set("title", "Screenshot");
    form.set(
      "content",
      JSON.stringify({ type: "doc", content: [{ type: "image", attrs: { mediaId: old.id, width: "100", align: "center", alt: "" } }] }),
    );
    const realFindMany = prisma.media.findMany.bind(prisma.media);
    vi.spyOn(prisma.media, "findMany").mockImplementationOnce((async (args: never) => {
      const found = await realFindMany(args);
      // …then the cleanup claimed it before the post was saved.
      await handlers.cleanupMedia({}, { info: () => {}, warn: () => {} });
      return found;
    }) as never);

    expect(await createPost({}, form)).toEqual({
      error: "An image is still uploading or can't be used here. Wait for it, or remove it.",
    });
    expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(0);
  });
});
