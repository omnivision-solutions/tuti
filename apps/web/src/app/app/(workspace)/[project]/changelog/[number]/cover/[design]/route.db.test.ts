import { imageKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./route";

/** The team's preview of an entry's cover in one design: drawn from the saved entry, nothing stored. */

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
afterEach(() => {
  vi.unstubAllEnvs();
  s3.beforeGet = undefined;
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const preview = (number: number | string, design: string, query = "", slug = project.slug) =>
  GET(new Request(`http://tuti.localhost:3100/app/${slug}/changelog/${number}/cover/${design}${query}`), { params: Promise.resolve({ project: slug, number: String(number), design }) });
const png = async (response: Response) => Buffer.from(await response.arrayBuffer());
const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("a team member gets each design that has something to show for the entry, at half the cover's size, and nothing is stored", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode", tags: ["new"], content: { type: "doc", content: [heading("Themes"), paragraph("Pick one."), heading("Search")] } });
  const stored = s3.objects.size;

  for (const design of ["title", "sections", "pattern"]) {
    const response = await preview(number, design);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    // Drawn from what's saved now, for this person: never kept.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { width, height, format } = await sharp(await png(response)).metadata();
    expect({ width, height, format }).toEqual({ width: 800, height: 420, format: "png" });
  }
  // A headline in the title's place draws another picture.
  const [titled, headlined] = [await png(await preview(number, "title")), await png(await preview(number, "title", "?headline=Now%20in%20the%20dark"))];
  expect(headlined.equals(titled)).toBe(false);
  // No image in the entry: no Screenshot. One heading only: no Sections.
  expect((await preview(number, "screenshot")).status).toBe(404);
  const plain = await call(createChangelogEntry, team(), { title: "Fixes", content: { type: "doc", content: [heading("Only one"), paragraph("Text.")] } });
  expect((await preview(plain.number, "sections")).status).toBe(404);
  expect((await preview(plain.number, "title")).status).toBe(200);

  expect(s3.objects.size).toBe(stored);
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(0);
});

test("Screenshot reads the entry's first image big enough to show: not an icon before it", async () => {
  const upload = (width: number, height: number) => prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", width, height } });
  const [icon, shot] = [await upload(64, 64), await upload(1200, 800)];
  await mediaStorage()!.put(imageKey(shot.id, 960), await sharp({ create: { width: 960, height: 640, channels: 3, background: "#3366cc" } }).webp().toBuffer(), "image/webp");
  const image = (mediaId: string) => ({ type: "image", attrs: { mediaId, width: "100", align: "center", alt: "" } });
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode", content: { type: "doc", content: [image(icon.id), paragraph("Pick a theme."), image(shot.id)] } });
  const read: string[] = [];
  s3.beforeGet = (key) => void read.push(key);

  const response = await preview(number, "screenshot");

  expect(response.status).toBe(200);
  expect((await sharp(await png(response)).metadata()).width).toBe(800);
  expect(read).toEqual([imageKey(shot.id, 960)]);
  // The other designs don't read it.
  read.length = 0;
  await preview(number, "title");
  expect(read).toEqual([]);
});

test("only the project's team: signed out, on another team, or for what isn't there, there's no cover", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode" });
  expect((await preview(number, "title")).status).toBe(200);
  for (const [n, design] of [[number, "poster"], [number + 1, "title"], ["1e3", "title"], ["abc", "title"]] as const) {
    expect((await preview(n, design)).status).toBe(404);
  }
  expect((await preview(number, "title", "", "no-such-project")).status).toBe(404);
  // Someone on another project's team.
  const outsider = await signUp("Outsider");
  await createProject(outsider);
  actAs(outsider);
  expect((await preview(number, "title")).status).toBe(404);
  actAs(null);
  const signedOut = await preview(number, "title");
  expect(signedOut.status).toBe(404);
  expect(signedOut.headers.get("cache-control")).toBe("private, no-store");
});
