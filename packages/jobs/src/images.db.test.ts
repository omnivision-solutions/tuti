import { emailImageKey, imageKey, imageWidths, originalKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { imageUploaded } from "./images";

let s3: S3Fake;
let png: Buffer;
let projectId: string;
let uploaderId: string;

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeAll(async () => {
  s3 = await startS3Fake();
  png = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#3a7" } }).png().toBuffer();
});

afterAll(() => s3.close());

beforeEach(async () => {
  s3.onPut = undefined;
  log.info.mockReset();
  log.warn.mockReset();
  log.error.mockReset();
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  const slug = `images-${Math.random().toString(36).slice(2, 10)}`;
  projectId = (await prisma.project.create({ data: { slug, name: "Images" } })).id;
  uploaderId = (await prisma.user.create({ data: { id: slug, name: "Uploader", email: `e2e-${slug}@example.com` } })).id;
});

afterEach(() => {
  s3.onPut = undefined;
  vi.unstubAllEnvs();
});

test("does not resurrect a media row marked FAILED while processing, and deletes derived files it wrote", async () => {
  const media = await prisma.media.create({
    data: { projectId, uploaderId, status: "PROCESSING", size: png.byteLength },
  });
  const storage = mediaStorage()!;
  await storage.put(originalKey(media.id), png, "image/png");

  const origUpdateMany = prisma.media.updateMany.bind(prisma.media);
  const spy = vi.spyOn(prisma.media, "updateMany").mockImplementationOnce(((args: Parameters<typeof origUpdateMany>[0]) =>
    prisma.media
      .update({ where: { id: media.id }, data: { status: "FAILED", size: 0 } })
      .then(() => origUpdateMany(args))) as unknown as typeof prisma.media.updateMany);

  try {
    const result = await imageUploaded({ mediaId: media.id }, log);

    expect(result).toEqual({ skipped: true });
    expect(await prisma.media.findUniqueOrThrow({ where: { id: media.id } })).toMatchObject({ status: "FAILED", size: 0 });
    for (const width of imageWidths(320)) {
      expect(s3.objects.has(imageKey(media.id, width))).toBe(false);
    }
    expect(s3.objects.has(emailImageKey(media.id))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
