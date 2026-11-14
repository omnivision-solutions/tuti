import { originalKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { createUpload, finishUpload, uploadStatus } from "./media";

// The queue is down when the browser says the upload is done.
const jobs = vi.hoisted(() => ({ enqueue: vi.fn<(name: string, input: unknown) => Promise<void>>() }));
vi.mock("@tuti/jobs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tuti/jobs")>()), enqueue: jobs.enqueue }));

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
afterEach(() => {
  vi.unstubAllEnvs();
});

test("an image the queue refused is failed, not left processing forever: no original kept, no quota counted", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const file = Buffer.from("not looked at: the job never runs");
  const created = (await createUpload(project.slug, { type: "image/jpeg", size: file.length })) as { mediaId: string; uploadUrl: string };
  await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(file), headers: { "content-type": "image/jpeg" } });
  jobs.enqueue.mockRejectedValueOnce(new Error("Hatchet unreachable"));

  expect(await finishUpload(created.mediaId)).toEqual({ error: "The image couldn't be processed" });

  expect(await uploadStatus(created.mediaId)).toEqual({ status: "FAILED" });
  expect(await prisma.media.findUniqueOrThrow({ where: { id: created.mediaId } })).toMatchObject({ status: "FAILED", size: 0 });
  expect(s3.objects.has(originalKey(created.mediaId))).toBe(false);
});


test("a worker that finished before enqueue reports an error keeps READY and its file", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const file = Buffer.from("completed by the worker");
  const created = (await createUpload(project.slug, { type: "image/jpeg", size: file.length })) as { mediaId: string; uploadUrl: string };
  await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(file), headers: { "content-type": "image/jpeg" } });
  jobs.enqueue.mockImplementationOnce(async () => {
    await prisma.media.update({ where: { id: created.mediaId }, data: { status: "READY", width: 10, height: 10 } });
    throw new Error("Hatchet response lost after accepting the job");
  });

  expect(await finishUpload(created.mediaId)).toEqual({ error: "The image couldn't be processed" });
  expect(await prisma.media.findUniqueOrThrow({ where: { id: created.mediaId } })).toMatchObject({ status: "READY", size: file.length });
  expect(s3.objects.has(originalKey(created.mediaId))).toBe(true);
});

test("a failed cleanup still marks the refused upload FAILED", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const file = Buffer.from("not processed");
  const created = (await createUpload(project.slug, { type: "image/jpeg", size: file.length })) as { mediaId: string; uploadUrl: string };
  await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(file), headers: { "content-type": "image/jpeg" } });
  jobs.enqueue.mockRejectedValueOnce(new Error("Hatchet unreachable"));
  s3.failDeletes.add(originalKey(created.mediaId));
  try {
    expect(await finishUpload(created.mediaId)).toEqual({ error: "The image couldn't be processed" });
    expect(await uploadStatus(created.mediaId)).toEqual({ status: "FAILED" });
  } finally {
    s3.failDeletes.delete(originalKey(created.mediaId));
  }
});
