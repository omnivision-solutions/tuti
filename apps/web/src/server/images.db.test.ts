import { imageKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { creditBalance, grantCredits, storeImage, UPLOADS_PER_HOUR_TEAM } from "@tuti/jobs";
import { creditsPerUsageDollar, DEFAULT_IMAGE_MODEL } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { configFile, creditsOn, FAKE_IMAGE_COST, type ModelFake, type S3Fake, startModelFake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { generateImage as generateAction } from "@/server/images";
import { AI_IMAGES_PER_HOUR, generateImageOperation } from "@/server/operations/images";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** AI images (images.generate): made by the image model (the model fake), cropped to the size asked, kept as an upload. */

let s3: S3Fake;
let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [s3, model] = await Promise.all([startS3Fake(), startModelFake()]);
});
afterAll(() => Promise.all([s3.close(), model.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...s3.env, ...model.env })) {
    vi.stubEnv(name, value);
  }
  model.images.length = 0;
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const generate = (input: { prompt?: string; width: number; height: number; references?: string[] }) =>
  call(generateImageOperation, team(), { prompt: "A lighthouse at dusk", ...input });

/** One of the project's images (a finished upload) of one colour. */
async function upload(projectId: string, uploaderId: string, background: string) {
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background } }).png().toBuffer();
  const stored = await storeImage(png, { projectId, uploaderId });
  return "mediaId" in stored ? stored.mediaId : expect.fail("not stored");
}

test("an image is made in the closest ratio and resolution, cropped to exactly the size, and kept as the member's finished upload", async () => {
  const image = await generate({ width: 1600, height: 840 });

  const media = await prisma.media.findUniqueOrThrow({ where: { id: image.id } });
  expect(media).toMatchObject({ projectId: project.id, uploaderId: owner.id, status: "READY", width: 1600, height: 840, filename: null, attachedAt: expect.any(Date) });
  expect(image).toEqual({ id: media.id, url: expect.stringContaining(`/api/media/${media.id}/480.webp`), width: 1600, height: 840 });
  const stored = await sharp(Buffer.from(await mediaStorage()!.get(imageKey(media.id, 1600)))).metadata();
  expect([stored.width, stored.height]).toEqual([1600, 840]);
  // 16:9 is the closest ratio to 1600:840, and 1K's 1376×768 can't hold it: 2K. Its top and bottom are cropped off, so the prompt says.
  expect(model.images).toEqual([
    {
      model: DEFAULT_IMAGE_MODEL,
      prompt: "A lighthouse at dusk\n\nKeep anything important away from the top and bottom edges: they will be cropped off.",
      references: [],
      aspectRatio: "16:9",
      imageSize: "2K",
      provider: { data_collection: "deny" },
      usage: { include: true },
    },
  ]);

  // A size in a ratio the model makes: nothing to crop, nothing added to the prompt; small, so 1K.
  const square = await generate({ width: 300, height: 300 });
  expect(square).toMatchObject({ width: 300, height: 300 });
  expect(model.images[1]).toMatchObject({ prompt: "A lighthouse at dusk", aspectRatio: "1:1", imageSize: "1K" });
});

test("references are the project's own images, sent in order once each; another project's is refused before the model is asked", async () => {
  const red = await upload(project.id, owner.id, "#ff0000");
  const blue = await upload(project.id, owner.id, "#0000ff");

  await generate({ width: 400, height: 400, references: [blue, red, blue] });
  const [sent] = model.images;
  expect(sent!.references).toHaveLength(2);
  // Each one its own image, as WebP, the first the one an edit starts from.
  const colours = await Promise.all(
    sent!.references.map(async (url) => {
      expect(url).toMatch(/^data:image\/webp;base64,/);
      const { channels } = await sharp(Buffer.from(url.split(",")[1]!, "base64")).stats();
      return channels[0]!.mean > 200 ? "red" : "blue";
    }),
  );
  expect(colours).toEqual(["blue", "red"]);

  const outsider = await signUp("Outsider");
  const other = await createProject(outsider);
  const theirs = await upload(other.id, outsider.id, "#00ff00");
  await expect(generate({ width: 400, height: 400, references: [red, theirs] })).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(generate({ width: 400, height: 400, references: ["nope"] })).rejects.toMatchObject({ status: 404 });
  expect(model.images).toHaveLength(1);
});

test("the image is recorded as `images` usage with its cost and charged in credits; out of credits, it's refused without asking", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 402, code: "no_credits" });
  expect(model.images).toHaveLength(0);

  await grantCredits(project.id, "MANUAL", 100, { days: null });
  await generate({ width: 2000, height: 2000 });
  const charged = FAKE_IMAGE_COST["2K"]! * creditsPerUsageDollar();
  const [usage] = await prisma.aiUsage.findMany({ where: { projectId: project.id } });
  expect(usage).toMatchObject({ feature: "images", kind: "chat", model: DEFAULT_IMAGE_MODEL, outputTokens: 1290 });
  expect(usage!.cost?.toNumber()).toBe(FAKE_IMAGE_COST["2K"]);
  expect(usage!.credits?.toNumber()).toBeCloseTo(charged);
  expect((await creditBalance(project.id)).balance).toBeCloseTo(100 - charged);
});

test("images need AI through OpenRouter, and uploads", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 503, code: "ai_unavailable", message: "AI isn't set up on this server" });
  // Another provider's key at its own address: chat works there, images don't.
  vi.stubEnv("OPENAI_API_KEY", "sk-another-provider");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.example.com/v1");
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 503, code: "ai_unavailable", message: "Generating images needs OpenRouter as this server's AI provider" });
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("MEDIA_S3_BUCKET", "");
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 503, code: "uploads_unavailable" });
  expect(model.images).toHaveLength(0);
});

test("past the hourly uploads or the quota, it's refused (409) before the model is asked; sizes outside the limits are refused", async () => {
  await prisma.media.createMany({
    data: Array.from({ length: UPLOADS_PER_HOUR_TEAM }, () => ({ projectId: project.id, uploaderId: owner.id, size: 1, status: "READY" as const })),
  });
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 409, code: "no_room" });
  // The quota: a teammate with uploads to spare, in a project with no space left.
  await prisma.media.deleteMany({ where: { projectId: project.id } });
  vi.stubEnv("TUTI_CONFIG", configFile({ media: { projectQuotaMb: 1 } }));
  // 300 KB left: enough for a 300×300 PNG at three bytes a pixel (264 KB), not for one that keeps transparency (356 KB).
  await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 1024 * 1024 - 300 * 1024, status: "READY" } });
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 409, code: "no_room" });
  expect(model.images).toHaveLength(0);
  expect(await prisma.aiUsage.count({ where: { projectId: project.id } })).toBe(0);
  // A small one fits in what's left.
  await expect(generate({ width: 100, height: 100 })).resolves.toMatchObject({ width: 100, height: 100 });

  await expect(generate({ width: 2401, height: 300 })).rejects.toMatchObject({ status: 400, message: "The width is at most 2,400 pixels" });
  await expect(generate({ width: 300, height: 63 })).rejects.toMatchObject({ status: 400, message: "The height is at least 64 pixels" });
  await expect(generate({ prompt: "  ", width: 300, height: 300 })).rejects.toMatchObject({ status: 400, message: "Describe the image" });
});

test("a model that fails, or answers without an image, is a 502 and keeps nothing; an answer is paid for all the same", async () => {
  model.failImage(503);
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 502, code: "ai_failed", message: "The AI couldn't make the image. Try again in a moment." });
  model.failImage();
  await expect(generate({ width: 300, height: 300 })).rejects.toMatchObject({ status: 502, code: "ai_failed" });
  expect(model.images).toHaveLength(2);
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(0);
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } })).toEqual([{ feature: "images" }]);
});

test("the app's action: the image for a teammate, an error for anyone else", async () => {
  actAs(owner);
  expect(await generateAction(project.slug, { prompt: "A lighthouse", width: 320, height: 200 })).toEqual({ image: expect.objectContaining({ width: 320, height: 200 }) });
  const outsider = await signUp("Outsider");
  actAs(outsider);
  expect(await generateAction(project.slug, { prompt: "A lighthouse", width: 320, height: 200 })).toEqual({ error: "Only the project's team can make images" });
  expect(model.images).toHaveLength(1);
  // A prompt missing from what was sent is refused as one, not made from the word "undefined".
  actAs(owner);
  expect(await generateAction(project.slug, { width: 320, height: 200 } as unknown as Parameters<typeof generateAction>[1])).toEqual({ error: "Describe the image" });
  expect(model.images).toHaveLength(1);
});

test("images asked for at once are counted before the model is asked: past the project's hourly cap, a 429 and no model request", async () => {
  // Two left this hour; the clock held mid-hour, so the hour can't turn (and the count reset) during the test.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-01T12:30:00Z") });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const hour = new Date("2026-06-01T12:00:00Z");
  await prisma.project.update({ where: { id: project.id }, data: { aiImagesHour: hour, aiImagesCount: AI_IMAGES_PER_HOUR - 2 } });
  // Refused ones don't use up the hour's images: out of credits, or references that can't be read.
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await expect(generate({ width: 128, height: 128 })).rejects.toMatchObject({ status: 402 });
  vi.stubEnv("TUTI_CONFIG", "");
  const unreadable = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 4, status: "READY", width: 32, height: 20 } });
  await expect(generate({ width: 128, height: 128, references: [unreadable.id] })).rejects.toMatchObject({ status: 503, code: "copy_failed" });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).aiImagesCount).toBe(AI_IMAGES_PER_HOUR - 2);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => generate({ width: 128, height: 128 })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual(
    Array.from({ length: 3 }, () => expect.objectContaining({ status: 429, code: "rate_limited" })),
  );
  expect(model.images).toHaveLength(2);
});
