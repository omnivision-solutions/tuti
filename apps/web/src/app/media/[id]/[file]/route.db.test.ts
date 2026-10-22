import { emailImageKey, imageKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { lastingMediaUrl } from "@/server/media-urls";
import { createProject, signUp } from "@/test/helpers";

import { GET } from "./route";

/** Lasting links to images (emails, link cards, exports): on to a fresh signed URL while the image is in use. */

let s3: S3Fake;
beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

async function image(data: { attachedAt?: Date | null; status?: "READY" | "PROCESSING" } = {}) {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const media = await prisma.media.create({
    data: { projectId: project.id, uploaderId: owner.id, size: 1, width: 600, height: 200, status: "READY", attachedAt: new Date(), ...data },
  });
  s3.objects.set(emailImageKey(media.id), { body: Buffer.from("jpeg"), contentType: "image/jpeg" });
  return media;
}

/** Opens a link the way the app's router would serve it. */
function open(link: string) {
  const url = new URL(link);
  const [, , id, file] = url.pathname.split("/");
  return GET(new Request(url), { params: Promise.resolve({ id: id!, file: file! }) });
}

test("goes on to a signed URL for the file, which reads it", async () => {
  const media = await image();
  const response = await open(lastingMediaUrl(emailImageKey(media.id)));
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
  const location = response.headers.get("location")!;
  expect(location).toContain(`/${emailImageKey(media.id)}?`);
  const file = await fetch(location);
  expect(file.status).toBe(200);
  expect(await file.text()).toBe("jpeg");
});

test("a link that wasn't signed for that file, or at all, goes nowhere", async () => {
  const media = await image();
  const other = new URL(lastingMediaUrl(imageKey(media.id, 480)));
  const forged = new URL(lastingMediaUrl(emailImageKey(media.id)));
  forged.searchParams.set("s", other.searchParams.get("s")!);
  expect((await open(forged.href)).status).toBe(404);
  forged.searchParams.delete("s");
  expect((await open(forged.href)).status).toBe(404);
});

test("gone once nothing uses the image, or before it's ready", async () => {
  const released = await image({ attachedAt: null });
  expect((await open(lastingMediaUrl(emailImageKey(released.id)))).status).toBe(404);
  const processing = await image({ status: "PROCESSING" });
  expect((await open(lastingMediaUrl(emailImageKey(processing.id)))).status).toBe(404);
  const deleted = await image();
  await prisma.media.delete({ where: { id: deleted.id } });
  const response = await open(lastingMediaUrl(emailImageKey(deleted.id)));
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
