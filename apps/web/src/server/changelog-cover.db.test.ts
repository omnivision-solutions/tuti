import { imageKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { UPLOADS_PER_HOUR_TEAM } from "@tuti/jobs";
import { mediaStorage } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { composeChangelogCover as composeAction, publishChangelogEntry as publishAction } from "@/server/changelog";
import * as coverCard from "@/server/cover-card";
import {
  composeChangelogCover,
  createChangelogEntry,
  getChangelogEntry,
  getChangelogStyle,
  publishChangelogEntry,
  updateChangelogStyle,
} from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** An entry's composed cover (changelog.composeCover): drawn from the entry and the portal's branding, kept as a normal cover. */

// The real drawing, watched: which design and what text each cover was drawn with.
vi.mock("@/server/cover-card", async (original) => {
  const real = await original<typeof import("@/server/cover-card")>();
  return { ...real, drawCover: vi.fn(real.drawCover) };
});
const drawn = () => vi.mocked(coverCard.drawCover).mock.calls.map(([site, content, design]) => ({ project: site.project.name, title: content.title, tag: content.tag, headings: content.headings, design }));

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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(coverCard.drawCover).mockClear();
  s3.beforeGet = undefined;
  s3.onPut = undefined;
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const compose = (input: { number: number; design?: "auto" | coverCard.CoverDesign; headline?: string }) => call(composeChangelogCover, team(), input);
const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const covers = () => prisma.media.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } });

test("a cover is composed, kept as the member's finished upload and set on the entry; made again, it replaces the one before", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode", tags: ["new"], content: { type: "doc", content: [heading("Themes"), paragraph("Pick one."), heading("Search")] } });

  const entry = await compose({ number });

  const [media] = await covers();
  // The cover's size, as processing kept it; attached, so the cleanup of unfinished uploads leaves it.
  expect(media).toMatchObject({ uploaderId: owner.id, status: "READY", width: 1600, height: 840, filename: null, attachedAt: expect.any(Date) });
  expect(entry.cover).toMatchObject({ id: media!.id, width: 1600, height: 840 });
  expect((await call(getChangelogEntry, team(), { number })).cover?.id).toBe(media!.id);
  // What's stored is the picture: its sizes, as any upload's.
  const stored = await sharp(Buffer.from(await mediaStorage()!.get(imageKey(media!.id, 1600)))).metadata();
  expect([stored.width, stored.height, stored.format]).toEqual([1600, 840, "webp"]);

  // Another design, with a headline of its own: a new upload is the cover now (release-media frees the old one).
  const again = await compose({ number, design: "sections", headline: "  Now in the dark " });
  expect(again.cover?.id).not.toBe(media!.id);
  // Each drawn as asked: the entry's own title, tag and headings in its own design first, then Sections with the headline.
  expect(drawn()).toEqual([
    { project: project.name, title: "Dark mode", tag: "New", headings: ["Themes", "Search"], design: "title" },
    { project: project.name, title: "Now in the dark", tag: "New", headings: ["Themes", "Search"], design: "sections" },
  ]);
  expect(await covers()).toHaveLength(2);
  // The entry's own title and text are as they were.
  expect(again).toMatchObject({ title: "Dark mode", body: entry.body });
  // A published entry gets one too, as it can take an uploaded cover.
  await call(publishChangelogEntry, team(), { number });
  expect((await compose({ number, design: "pattern" })).status).toBe("published");
});

test("with no design picked, the entry's image where it has one big enough, else its title; a design with nothing to show is refused, and nothing kept", async () => {
  const plain = await call(createChangelogEntry, team(), { title: "Fixes", content: { type: "doc", content: [heading("Only one"), paragraph("Text.")] } });
  await expect(compose({ number: plain.number, design: "screenshot" })).rejects.toMatchObject({ status: 400, message: "This entry has no image at least 600px wide for the Screenshot design" });
  await expect(compose({ number: plain.number, design: "sections" })).rejects.toMatchObject({ status: 400, message: "This entry needs two headings for the Sections design" });
  await expect(compose({ number: plain.number, headline: "x".repeat(91) })).rejects.toMatchObject({ status: 400, message: "Keep the headline under 90 characters" });
  await expect(compose({ number: plain.number + 5 })).rejects.toMatchObject({ status: 404 });
  expect(await covers()).toEqual([]);

  const shot = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", width: 1200, height: 800 } });
  await mediaStorage()!.put(imageKey(shot.id, 960), await sharp({ create: { width: 960, height: 640, channels: 3, background: "#3366cc" } }).webp().toBuffer(), "image/webp");
  const pictured = await call(createChangelogEntry, team(), {
    title: "Dark mode",
    content: { type: "doc", content: [paragraph("Pick a theme."), { type: "image", attrs: { mediaId: shot.id, width: "100", align: "center", alt: "" } }] },
  });
  const read: string[] = [];
  s3.beforeGet = (key) => void read.push(key);
  // No image to read for the one without: its title's design.
  await compose({ number: plain.number });
  expect(read).not.toContain(imageKey(shot.id, 960));
  await compose({ number: pictured.number });
  expect(read).toContain(imageKey(shot.id, 960));
  expect(drawn().map((cover) => cover.design)).toEqual(["title", "screenshot"]);

  // Storage loses the image's file: Screenshot asked for by name is refused, to try again, and the cover it has stays;
  // nobody picking (`auto`), the entry gets its title's design instead.
  const had = (await call(getChangelogEntry, team(), { number: pictured.number })).cover!.id;
  s3.objects.delete(imageKey(shot.id, 960));
  await expect(compose({ number: pictured.number, design: "screenshot" })).rejects.toMatchObject({ status: 503, code: "copy_failed", message: "Couldn't read the entry's image just now: try again in a moment" });
  expect((await call(getChangelogEntry, team(), { number: pictured.number })).cover!.id).toBe(had);
  expect((await compose({ number: pictured.number })).cover!.id).not.toBe(had);
});

test("an entry deleted while its cover is drawn is gone (a 404), not an error of ours", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode" });
  const real = await vi.importActual<typeof import("@/server/cover-card")>("@/server/cover-card");
  vi.mocked(coverCard.drawCover).mockImplementationOnce(async (...args) => {
    await prisma.changelogEntry.delete({ where: { projectId_number: { projectId: project.id, number } } });
    return real.drawCover(...args);
  });

  await expect(compose({ number })).rejects.toMatchObject({ status: 404, code: "not_found", message: `There's no changelog entry #${number}` });
  // The cover was drawn and kept, and it's no entry's: a finished upload like any unused one, for the daily release to free.
  const [kept] = await covers();
  expect(await covers()).toHaveLength(1);
  expect(kept).toMatchObject({ status: "READY", width: 1600, height: 840 });
  expect(await prisma.changelogEntry.count({ where: { coverId: kept!.id } })).toBe(0);
});

test("a cover that's drawn but can't be kept (storage's own trouble) is a 503 to try again: the entry keeps the cover it has", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode" });
  const first = await compose({ number });
  // Storage refuses the new picture as it's stored.
  s3.onPut = (key) => (key.startsWith("uploads/") ? 500 : undefined);

  await expect(compose({ number, design: "pattern" })).rejects.toMatchObject({ status: 503, code: "copy_failed", message: "Couldn't keep the cover just now: try again in a moment" });

  expect(await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } }, select: { coverId: true } })).toEqual({ coverId: first.cover!.id });
  // What was reserved for it is marked failed and in no one's use: off the quota, for the cleanup.
  const uploads = await covers();
  expect(uploads).toHaveLength(2);
  expect(uploads.find((upload) => upload.id !== first.cover!.id)).toMatchObject({ status: "FAILED", attachedAt: null, size: 0 });
});

test("without uploads set up it's a 503, and past the member's hourly uploads a 409: the entry keeps the cover it has", async () => {
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode" });
  const first = await compose({ number });

  await prisma.media.createMany({
    data: Array.from({ length: UPLOADS_PER_HOUR_TEAM }, () => ({ projectId: project.id, uploaderId: owner.id, size: 1, status: "READY" as const })),
  });
  await expect(compose({ number })).rejects.toMatchObject({ status: 409, code: "no_room" });
  // Publishing with the design its dialog picked: nothing goes out, and the error says how it can.
  actAs(owner);
  const draft = await call(createChangelogEntry, team(), { title: "Search" });
  expect(await publishAction(project.slug, draft.number, true, false, "title")).toEqual({ error: expect.stringMatching(/Pick No cover to publish without one\.$/) });
  expect((await call(getChangelogEntry, team(), { number: draft.number })).status).toBe("draft");

  vi.stubEnv("MEDIA_S3_BUCKET", "");
  await expect(compose({ number })).rejects.toMatchObject({ status: 503, code: "uploads_unavailable", message: "Uploads aren't set up on this server" });
  expect(await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } }, select: { coverId: true } })).toEqual({ coverId: first.cover!.id });
});

test("in the app: Publish with a design picked adds that cover first, and publishes nothing if it can't; Make a cover sets one with its headline", async () => {
  actAs(owner);
  const { number } = await call(createChangelogEntry, team(), { title: "Dark mode" });
  const entry = () => prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } }, select: { coverId: true, publishedAt: true } });

  // A design with nothing to show for it (the entry lost its image since the dialog opened): still a draft, no cover.
  expect(await publishAction(project.slug, number, true, false, "screenshot")).toEqual({ error: "This entry has no image at least 600px wide for the Screenshot design" });
  expect(await entry()).toEqual({ coverId: null, publishedAt: null });
  // A design that isn't one: refused as the operation's input would be, nothing made or published.
  expect(await publishAction(project.slug, number, true, false, "poster" as "title")).toEqual({ error: expect.stringContaining("expected one of") });
  expect(await entry()).toEqual({ coverId: null, publishedAt: null });

  expect(await composeAction(project.slug, number, "pattern", " Now in the dark ")).toEqual({});
  const made = (await entry()).coverId;
  expect(made).not.toBeNull();
  expect(drawn()).toEqual([expect.objectContaining({ design: "pattern", title: "Now in the dark" })]);

  // Published with the design picked in its dialog: that cover, then out.
  const fresh = await call(createChangelogEntry, team(), { title: "Search" });
  const saved = (n: number) => prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: n } }, select: { coverId: true, publishedAt: true } });
  expect(await publishAction(project.slug, fresh.number, true, false, "title")).toEqual({});
  expect(await saved(fresh.number)).toEqual({ coverId: expect.any(String), publishedAt: expect.any(Date) });
  expect(drawn().at(-1)).toMatchObject({ design: "title", title: "Search" });

  // A dialog opened before the entry had its cover (a teammate's, or the one made above): that cover stays, nothing is
  // drawn over it. Nor over one published meanwhile.
  const before = drawn().length;
  expect(await publishAction(project.slug, number, true, false, "title")).toEqual({});
  expect(await entry()).toEqual({ coverId: made, publishedAt: expect.any(Date) });
  const out = await saved(fresh.number);
  await prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: fresh.number } }, data: { coverId: null } });
  expect(await publishAction(project.slug, fresh.number, true, false, "pattern")).toEqual({});
  expect(await saved(fresh.number)).toEqual({ coverId: null, publishedAt: out.publishedAt });
  expect(drawn()).toHaveLength(before);

  // A cover a teammate sets, or the entry they publish, while the picked one is drawn: theirs stays, and the drawing isn't kept on it.
  const real = await vi.importActual<typeof import("@/server/cover-card")>("@/server/cover-card");
  for (const meanwhile of [{ coverId: made }, { publishedAt: new Date("2026-11-24T12:00:00Z") }]) {
    const raced = await call(createChangelogEntry, team(), { title: "Raced" });
    vi.mocked(coverCard.drawCover).mockImplementationOnce(async (...args) => {
      await prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: raced.number } }, data: meanwhile });
      return real.drawCover(...args);
    });
    expect(await publishAction(project.slug, raced.number, true, false, "title")).toEqual({});
    expect(await saved(raced.number)).toEqual({ coverId: meanwhile.coverId ?? null, publishedAt: expect.any(Date) });
  }

  // Lines left to fill in, added since the dialog opened: publishing refuses it, and no cover is made for it.
  const marked = await call(createChangelogEntry, team(), { title: "Marked", body: "Dark mode.\n[Check: on iOS?]" });
  const drawnBefore = drawn().length;
  expect(await publishAction(project.slug, marked.number, true, false, "title")).toEqual({ error: expect.stringContaining("[Check: on iOS?]") });
  expect(await saved(marked.number)).toEqual({ coverId: null, publishedAt: null });
  expect(drawn()).toHaveLength(drawnBefore);

  // No design (its dialog's "No cover", or an entry that has one): published as it is.
  const plain = await call(createChangelogEntry, team(), { title: "Fixes" });
  expect(await publishAction(project.slug, plain.number)).toEqual({});
  expect(await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: plain.number } }, select: { coverId: true } })).toEqual({ coverId: null });
});

/** A finished image of the project's, stored at the widths processing keeps (the ones a cover reads). */
async function storedImage(width: number, height: number, projectId = project.id) {
  const media = await prisma.media.create({ data: { projectId, uploaderId: owner.id, size: 10, status: "READY", width, height } });
  for (const each of [960, 1600].filter((w) => w < width)) {
    await mediaStorage()!.put(imageKey(media.id, each), await sharp({ create: { width: each, height: Math.round((each * height) / width), channels: 3, background: "#cc6633" } }).webp().toBuffer(), "image/webp");
  }
  return media;
}
const setStyle = (input: { coverDesign?: "" | coverCard.CoverDesign; coverBackground?: string | null; tone?: string; screenshotMarkers?: boolean }) =>
  call(updateChangelogStyle, team(), input);

test("Your background is offered once the team has a background, and draws on it; nobody picking, the team's design comes first where the entry has what it needs", async () => {
  const shot = await storedImage(1200, 800);
  const plain = await call(createChangelogEntry, team(), { title: "Fixes" });
  const pictured = await call(createChangelogEntry, team(), {
    title: "Dark mode",
    content: { type: "doc", content: [paragraph("Pick a theme."), { type: "image", attrs: { mediaId: shot.id, width: "100", align: "center", alt: "" } }] },
  });
  const designsOf = async (number: number) => coverCard.coverDesigns(await coverCard.coverContent(project.id, await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } } })));

  // No background: not offered, and asked for by name it's refused.
  expect(await designsOf(plain.number)).toEqual(["title", "pattern"]);
  await expect(compose({ number: plain.number, design: "background" })).rejects.toMatchObject({ status: 400, message: "Add a cover background in Settings → Changelog for the Your background design" });

  const background = await storedImage(2400, 1200);
  await setStyle({ coverBackground: background.id });
  expect(await designsOf(plain.number)).toEqual(["title", "pattern", "background"]);
  const read: string[] = [];
  s3.beforeGet = (key) => void read.push(key);
  await compose({ number: plain.number, design: "background" });
  // Read at the cover's width, not a thumbnail's.
  expect(read).toContain(imageKey(background.id, 1600));
  expect(drawn().at(-1)).toMatchObject({ design: "background", title: "Fixes" });

  // The team's design, where the entry has what it needs.
  await setStyle({ coverDesign: "pattern" });
  await compose({ number: pictured.number });
  await setStyle({ coverDesign: "background" });
  await compose({ number: pictured.number });
  // Screenshot on an entry with no image: the usual pick, its title's design.
  await setStyle({ coverDesign: "screenshot" });
  await compose({ number: plain.number });
  // Your background once the background's removed: the usual pick, the entry's image.
  await setStyle({ coverDesign: "background", coverBackground: null });
  await compose({ number: pictured.number });
  expect(drawn().slice(-4).map((cover) => cover.design)).toEqual(["pattern", "background", "title", "screenshot"]);

  // Storage loses the background's file: asked for by name it's refused, to try again.
  await setStyle({ coverBackground: background.id });
  s3.objects.delete(imageKey(background.id, 1600));
  await expect(compose({ number: plain.number, design: "background" })).rejects.toMatchObject({ status: 503, message: "Couldn't read the cover background just now: try again in a moment" });
});

test("the cover's design and background are saved and checked, each on its own: the writing style keeps them, and they keep it", async () => {
  expect(await call(getChangelogStyle, team(), {})).toMatchObject({ coverDesign: "", coverBackground: null });
  const background = await storedImage(2400, 1200);

  expect(await setStyle({ coverDesign: "sections", coverBackground: background.id })).toMatchObject({
    coverDesign: "sections",
    coverBackground: { id: background.id, url: expect.stringContaining(background.id), width: 2400, height: 1200 },
  });
  // Attached as it's set, so the cleanup of unfinished uploads leaves it.
  expect((await prisma.media.findUniqueOrThrow({ where: { id: background.id } })).attachedAt).toEqual(expect.any(Date));

  // Each setting on its own: the writing style's keep the cover's, and the other way round.
  await setStyle({ tone: "Short sentences.", screenshotMarkers: true });
  expect(await call(getChangelogStyle, team(), {})).toMatchObject({ tone: "Short sentences.", screenshotMarkers: true, coverDesign: "sections", coverBackground: { id: background.id } });
  expect(await setStyle({ coverDesign: "" })).toMatchObject({ tone: "Short sentences.", screenshotMarkers: true, coverDesign: "", coverBackground: { id: background.id } });
  expect(await setStyle({ coverBackground: null })).toMatchObject({ tone: "Short sentences.", coverDesign: "", coverBackground: null });
  expect(await setStyle({ coverDesign: "pattern" })).toMatchObject({ coverDesign: "pattern", coverBackground: null });

  // Not a design; an upload that's another project's, unfinished, or a file rather than an image: refused, nothing changed.
  await expect(setStyle({ coverDesign: "poster" as "title" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("expected one of") });
  const other = await createProject(owner);
  const theirs = await storedImage(2400, 1200, other.id);
  const unfinished = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "PROCESSING" } });
  const file = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", filename: "notes.pdf" } });
  for (const id of [theirs.id, unfinished.id, file.id, "nothing"]) {
    await expect(setStyle({ coverDesign: "title", coverBackground: id })).rejects.toMatchObject({ status: 409, code: "media_gone" });
  }
  expect(await call(getChangelogStyle, team(), {})).toMatchObject({ coverDesign: "pattern", coverBackground: null });
});
