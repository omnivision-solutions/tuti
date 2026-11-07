import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileKey, imageKey, videoKey } from "@tuti/content";
import { htmlToContent } from "@tuti/content/html";
import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { mediaImporter } from "./import-media";

let s3: S3Fake;
let server: Server;
let origin: string;
/** Requests the other tool's server answered, by path. */
let served: string[];
let png: Buffer;
/** Just over the app's 10 MB per image: uncompressed, as other tools often keep screenshots. */
let bigPng: Buffer;
/** Runs as each file is asked for, before it's answered. */
let whileServing: (() => Promise<void>) | undefined;
const PDF = Buffer.from("%PDF-1.4\n%invented test file\n");
/** The start of an MP4 (an ISO media file's `ftyp` box), then made-up frames. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom\0\0\0\0isommp41"), Buffer.alloc(64, 7)]);

beforeAll(async () => {
  s3 = await startS3Fake();
  png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#3a7" } }).png().toBuffer();
  bigPng = await sharp({ create: { width: 2000, height: 1800, channels: 3, background: "#37a" } }).png({ compressionLevel: 0 }).toBuffer();
  const files: Record<string, { type: string; body: Buffer }> = {
    "/a.png": { type: "image/png", body: png },
    "/big.png": { type: "image/png", body: bigPng },
    "/page.png": { type: "image/png", body: Buffer.from("<!doctype html><p>Not an image</p>") },
    "/huge.png": { type: "image/png", body: Buffer.alloc(2 * 1024 * 1024 + 1) },
    "/guide.pdf": { type: "application/pdf", body: PDF },
    "/fake.pdf": { type: "application/pdf", body: Buffer.from("<html>not a pdf</html>") },
    "/demo.mp4": { type: "video/mp4", body: MP4 },
    "/stream": { type: "video/mp4", body: MP4 },
    "/fake.mp4": { type: "video/mp4", body: Buffer.from("<!doctype html><p>Not a video</p>") },
    "/huge.mp4": { type: "video/mp4", body: Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]) },
  };
  server = createServer(async (req, res) => {
    served.push(req.url!);
    await whileServing?.();
    if (req.url === "/moved.png" || req.url === "/loop.png") {
      res.writeHead(302, { location: req.url === "/loop.png" ? "/loop.png" : "/a.png" }).end();
      return;
    }
    if (req.url === "/streamed.png") {
      // No length up front: only reading it tells it's too big.
      res.writeHead(200, { "content-type": "image/png" });
      for (let i = 0; i < 3; i++) {
        res.write(Buffer.alloc(1024 * 1024));
      }
      res.end();
      return;
    }
    const file = files[new URL(req.url!, origin).pathname];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": file.type }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await s3.close();
  await new Promise((resolve) => server.close(resolve));
});

let projectId: string;
let uploaderId: string;
beforeEach(async () => {
  served = [];
  whileServing = undefined;
  s3.onPut = undefined;
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  vi.stubEnv("MEDIA_MAX_IMPORT_IMAGE_MB", "2");
  const slug = `import-${Math.random().toString(36).slice(2, 10)}`;
  projectId = (await prisma.project.create({ data: { slug, name: "Import" } })).id;
  uploaderId = (await prisma.user.create({ data: { id: slug, name: "Importer", email: `e2e-${slug}@example.com` } })).id;
});
afterEach(() => vi.unstubAllEnvs());

const importer = (cache?: Parameters<typeof mediaImporter>[0]["cache"]) => mediaImporter({ projectId, uploaderId, cache });

test("an image is copied, processed at once and attached, and the content points at it with its size", async () => {
  const result = await htmlToContent("article", `<p>Before</p><img src="${origin}/moved.png" alt="The settings page" data-width="50%">`, { media: importer() });
  if ("error" in result) {
    throw new Error(result.error);
  }
  const [mediaId] = result.mediaIds;
  expect(result.leftOut).toEqual([]);
  expect(result.doc.content?.[1]).toEqual({
    type: "image",
    attrs: { mediaId, width: "50", align: "center", alt: "The settings page", w: 640, h: 480 },
  });
  const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
  expect(media).toMatchObject({ projectId, uploaderId, status: "READY", width: 640, height: 480, attachedAt: expect.any(Date) });
  expect(s3.objects.has(imageKey(mediaId!, 640))).toBe(true);
  // Followed the redirect; the original is gone once processed.
  expect(served).toEqual(["/moved.png", "/a.png"]);
  // Not in what the app's hourly upload limit counts for the person who ran the import.
  expect(await prisma.media.count({ where: { uploaderId, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } } })).toBe(0);
  expect([...s3.objects.keys()].filter((key) => key.startsWith("uploads/"))).toEqual([]);
});

test("an image over the app's upload limit but within the import's is copied, kept at the size of what's stored", async () => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  expect(bigPng.byteLength).toBeGreaterThan(10 * 1024 * 1024);
  const copy = await importer()({ kind: "image", url: `${origin}/big.png`, key: "big" });
  expect(copy).toMatchObject({ mediaId: expect.any(String), width: 2000, height: 1800 });
  // The quota counts the WebP sizes and email JPEG kept, not the original.
  const { size } = await prisma.media.findUniqueOrThrow({ where: { id: (copy as { mediaId: string }).mediaId } });
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThan(1024 * 1024);
});

test("an attached document in an article is copied as a file, checked by its content", async () => {
  const result = await htmlToContent(
    "article",
    `<file-preview-component src="${origin}/guide.pdf" data-featurebase-content-filename="Setup guide.pdf" data-featurebase-content-filetype="application/pdf"></file-preview-component>` +
      `<file-preview-component src="${origin}/fake.pdf" data-featurebase-content-filename="Price list.pdf" data-featurebase-content-filetype="application/pdf"></file-preview-component>`,
    { media: importer() },
  );
  if ("error" in result) {
    throw new Error(result.error);
  }
  const [mediaId] = result.mediaIds;
  expect(result.doc.content).toEqual([
    { type: "file", attrs: { mediaId, name: "Setup guide.pdf", size: PDF.byteLength } },
    { type: "paragraph", content: [{ type: "text", text: "Price list.pdf" }] },
  ]);
  expect(result.leftOut).toEqual([{ kind: "file", url: `${origin}/fake.pdf`, reason: "type" }]);
  expect(s3.objects.get(fileKey(mediaId!))?.body).toEqual(PDF);
  expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "READY", filename: "Setup guide.pdf" });
});

test("an uploaded video in an article is copied, checked by its content, and plays from the copy", async () => {
  vi.stubEnv("MEDIA_MAX_VIDEO_MB_TEAM", "1");
  // Streamed from a temporary file (in a directory of this test's own), never whole in the worker's memory, and the file
  // gone after. The first PUT meets a storage hiccup: it's sent again, from the file.
  const temporary = await mkdtemp(join(tmpdir(), "import-media-test-"));
  vi.stubEnv("TMPDIR", temporary);
  const puts: Record<string, string | string[] | undefined>[] = [];
  s3.onPut = (_key, headers) => (puts.push(headers) === 1 ? 503 : undefined);
  const result = await htmlToContent(
    "article",
    `<video src="${origin}/demo.mp4" controls></video><video><source src="${origin}/stream" type="video/mp4"></video>` +
      `<video src="${origin}/fake.mp4"></video><video src="${origin}/huge.mp4"></video>`,
    { media: importer() },
  );
  if ("error" in result) {
    throw new Error(result.error);
  }
  const [demo, stream] = result.mediaIds;
  expect(result.doc.content).toEqual([
    { type: "video", attrs: { provider: "upload", id: demo } },
    { type: "video", attrs: { provider: "upload", id: stream } },
  ]);
  expect(result.leftOut).toEqual([
    { kind: "video", url: `${origin}/fake.mp4`, reason: "type" },
    { kind: "video", url: `${origin}/huge.mp4`, reason: "size" },
  ]);
  expect(s3.objects.get(videoKey(demo!))).toEqual({ body: MP4, contentType: "video/mp4" });
  // Named so it's a video upload: as its address has it, or by its content when the address has no name for it.
  expect(await prisma.media.findMany({ where: { id: { in: [demo!, stream!] } }, select: { filename: true, status: true, size: true }, orderBy: { filename: "asc" } })).toEqual([
    { filename: "demo.mp4", status: "READY", size: MP4.length },
    { filename: "stream.mp4", status: "READY", size: MP4.length },
  ]);
  s3.onPut = undefined;
  expect(puts).toEqual(Array(3).fill(expect.objectContaining({ "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "content-length": String(MP4.length) })));
  expect(await readdir(temporary)).toEqual([]);
  await rm(temporary, { recursive: true });
});

test("what can't be copied is left out with its reason, keeping its alt text, and nothing is kept for it", async () => {
  const result = await htmlToContent(
    "post",
    `<img src="${origin}/page.png" alt="Not an image"><img src="${origin}/huge.png" alt="Too big"><img src="${origin}/streamed.png" alt="Too big too">` +
      `<img src="${origin}/missing.png" alt="Gone"><img src="${origin}/loop.png" alt="Round and round">`,
    { media: importer() },
  );
  if ("error" in result) {
    throw new Error(result.error);
  }
  expect(result.mediaIds).toEqual([]);
  expect(result.text).toBe("Not an image\nToo big\nToo big too\nGone\nRound and round");
  expect(result.leftOut.map((item) => item.reason)).toEqual(["type", "size", "size", "unreachable", "unreachable"]);
  // Three redirects at most.
  expect(served.filter((path) => path === "/loop.png")).toHaveLength(4);
  // The one that was stored to be checked failed and stopped counting against the quota.
  expect(await prisma.media.findMany({ where: { projectId }, select: { status: true, size: true, attachedAt: true } })).toEqual([
    { status: "FAILED", size: 0, attachedAt: null },
  ]);
});

test("the project isn't locked while a file is fetched (importers lock it after)", async () => {
  const locked: boolean[] = [];
  whileServing = async () => {
    const free = await prisma
      .$transaction((tx) => tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE NOWAIT`)
      .then(() => true, () => false);
    locked.push(!free);
  };
  expect(await importer()({ kind: "image", url: `${origin}/a.png`, key: "a" })).toMatchObject({ width: 640 });
  expect(locked).toEqual([false]);
});

test("a private address is refused before anything is fetched", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
  const copy = await importer()({ kind: "image", url: `https://127.0.0.1:${new URL(origin).port}/a.png`, key: "a" });
  expect(copy).toEqual({ leftOut: "unreachable" });
  expect(served).toEqual([]);
});

test("a large image counts against the quota no more than the app's per-image limit while it's processed", async () => {
  vi.stubEnv("MEDIA_MAX_IMPORT_IMAGE_MB", "");
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "11");
  // Room for 10 MB more, not for the whole original.
  await prisma.media.create({ data: { projectId, uploaderId, size: 1024 * 1024 - 100, status: "READY" } });
  expect(await importer()({ kind: "image", url: `${origin}/big.png`, key: "big" })).toMatchObject({ mediaId: expect.any(String) });
});

test("a self-hoster's lower upload limit doesn't shrink what an imported image reserves while it's processed", async () => {
  vi.stubEnv("MEDIA_MAX_IMPORT_IMAGE_MB", "");
  vi.stubEnv("MEDIA_MAX_IMAGE_MB_TEAM", "1");
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "6");
  // Room for 5 MB: the image reserves the fixed 10 MB bound, not the 1 MB editor limit, so it doesn't fit.
  await prisma.media.create({ data: { projectId, uploaderId, size: 1024 * 1024, status: "READY" } });
  expect(await importer()({ kind: "image", url: `${origin}/big.png`, key: "big" })).toEqual({ leftOut: "quota" });
});

test("a full project's quota leaves the image out", async () => {
  vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "1");
  await prisma.media.create({ data: { projectId, uploaderId, size: 1024 * 1024 - 100, status: "READY" } });
  const copy = await importer()({ kind: "image", url: `${origin}/a.png`, key: "a" });
  expect(copy).toEqual({ leftOut: "quota" });
  expect(await prisma.media.count({ where: { projectId } })).toBe(1);
});

test("with the import's cache, a file that's gone is asked for once, however it's signed", async () => {
  const cache = new Map();
  const media = importer(cache);
  const first = await media({ kind: "image", url: `${origin}/missing.png?X-Amz-Signature=one`, key: `${origin}/missing.png` });
  const second = await media({ kind: "image", url: `${origin}/missing.png?X-Amz-Signature=two`, key: `${origin}/missing.png` });
  expect([first, second]).toEqual([{ leftOut: "unreachable" }, { leftOut: "unreachable" }]);
  expect(served).toHaveLength(1);
});

test("storage failing leaves the file out (its row failed, off the quota) rather than failing the document", async () => {
  vi.stubEnv("MEDIA_S3_ENDPOINT", "http://127.0.0.1:9");
  const result = await htmlToContent("post", `<p>Before</p><img src="${origin}/a.png" alt="Shot"><p>After</p>`, { media: importer() });
  if ("error" in result) {
    throw new Error(result.error);
  }
  expect(result.leftOut).toEqual([{ kind: "image", url: `${origin}/a.png`, reason: "unreachable" }]);
  expect(result.text).toContain("After");
  expect(await prisma.media.findMany({ where: { projectId }, select: { status: true, size: true, attachedAt: true } })).toEqual([
    { status: "FAILED", size: 0, attachedAt: null },
  ]);
});

test("a storage failure isn't remembered by the cache: the next document tries again", async () => {
  const cache = new Map();
  const source = { kind: "image" as const, url: `${origin}/a.png`, key: `${origin}/a.png` };
  vi.stubEnv("MEDIA_S3_ENDPOINT", "http://127.0.0.1:9");
  expect(await importer(cache)(source)).toEqual({ leftOut: "unreachable" });
  vi.stubEnv("MEDIA_S3_ENDPOINT", s3.env.MEDIA_S3_ENDPOINT!);
  expect(await importer(cache)(source)).toMatchObject({ mediaId: expect.any(String) });
});

test("with the import's cache, the same file is fetched and stored once, across documents", async () => {
  const cache = new Map();
  // Featurebase signs each URL afresh.
  const img = (signature: string) => `<img src="${origin}/a.png?X-Amz-Signature=${signature}">`;
  const first = await htmlToContent("post", img("one") + img("two"), { media: importer(cache) });
  const second = await htmlToContent("post", img("three"), { media: importer(cache) });
  if ("error" in first || "error" in second) {
    throw new Error("not converted");
  }
  expect(served).toHaveLength(1);
  expect(first.mediaIds).toEqual(second.mediaIds);
  expect(first.doc.content).toHaveLength(2);
  expect(await prisma.media.count({ where: { projectId } })).toBe(1);
});
