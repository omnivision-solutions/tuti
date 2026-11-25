import { imageKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./route";

/** Settings → Changelog's cover designs: each drawn on a sample entry with the portal's branding, nothing stored. */

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
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

const preview = (design: string, query = "", slug = project.slug) =>
  GET(new Request(`http://tuti.localhost:3100/app/${slug}/settings/changelog/cover/${design}${query}`), { params: Promise.resolve({ project: slug, design }) });
const png = async (response: Response) => Buffer.from(await response.arrayBuffer());

/** A finished image of the project's, stored at the width a background is read at. */
async function storedImage(projectId = project.id) {
  const media = await prisma.media.create({ data: { projectId, uploaderId: owner.id, size: 10, status: "READY", width: 2400, height: 1200 } });
  await mediaStorage()!.put(imageKey(media.id, 1600), await sharp({ create: { width: 1600, height: 800, channels: 3, background: "#cc6633" } }).webp().toBuffer(), "image/webp");
  return media;
}

test("with no entries at all, each design is drawn on the sample entry, Screenshot with a sample picture, and nothing is stored", async () => {
  const stored = s3.objects.size;
  const pictures: Buffer[] = [];
  for (const design of ["title", "screenshot", "sections", "pattern"]) {
    const response = await preview(design);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const picture = await png(response);
    const { width, height, format } = await sharp(picture).metadata();
    expect({ width, height, format }).toEqual({ width: 800, height: 420, format: "png" });
    pictures.push(picture);
  }
  // Each its own design, not Title in their place.
  expect(new Set(pictures.map((picture) => picture.toString("base64"))).size).toBe(4);
  expect(s3.objects.size).toBe(stored);
});

test("Your background draws the one uploaded and not saved yet, else the one saved; none, or another project's, is no picture", async () => {
  expect((await preview("background")).status).toBe(404);
  const mine = await storedImage();
  const unsaved = await preview("background", `?background=${mine.id}`);
  expect(unsaved.status).toBe(200);
  await prisma.project.update({ where: { id: project.id }, data: { changelogCoverBackgroundId: mine.id } });
  expect((await png(await preview("background"))).equals(await png(unsaved))).toBe(true);

  const other = await createProject(await signUp("Other"));
  const theirs = await storedImage(other.id);
  expect((await preview("background", `?background=${theirs.id}`)).status).toBe(404);
});

test("owners and admins only, as the page is", async () => {
  expect((await preview("title")).status).toBe(200);
  expect((await preview("poster")).status).toBe(404);
  expect((await preview("title", "", "no-such-project")).status).toBe(404);
  actAs(await addMember(project.id, "ADMIN"));
  expect((await preview("title")).status).toBe(200);
  actAs(await addMember(project.id, "MEMBER"));
  expect((await preview("title")).status).toBe(404);
  actAs(null);
  expect((await preview("title")).status).toBe(404);
});
