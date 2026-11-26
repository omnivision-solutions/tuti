import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { creditBalance, grantCredits, placeChangelogScreenshots } from "@tuti/jobs";
import { type BrowserUseFake, creditsOn, type S3Fake, startBrowserUseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { entryScreenshots, entryScreenshotsRunning, placeLeftoverScreenshots, SCREENSHOTS_PLACED, takeChangelogScreenshots, updateScreenshotSettings } from "@/server/operations/screenshots";
import { saveChangelogEntry } from "@/server/changelog";
import { actAs, createProject, signUp, type TestUser, untilWaitingOnLock } from "@/test/helpers";

/** Changelog drafts' "[Screenshot: …]" lines filled with screenshots (docs/plan.md, SC2): Browser Use's fake, jobs inline. */

let browserUse: BrowserUseFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  browserUse = await startBrowserUseFake();
  s3 = await startS3Fake();
});
afterAll(() => Promise.all([browserUse.close(), s3.close()]));

beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...browserUse.env, ...s3.env })) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const setUp = () => call(updateScreenshotSettings, as(), { appUrl: "https://app.example.com", signIn: "none" });
const TEXT = ["Billing got a new look.", "[Screenshot: The billing page]", "Reports are here.", "[Screenshot: The reports page]", "See the [Screenshot: inline one] too."].join("\n\n");
const draft = (body = TEXT) => call(createChangelogEntry, as(), { title: "November", body });
const saved = (number: number) => prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number }, select: { id: true, body: true, content: true, updatedAt: true } });

test("each line's screenshot replaces it, its description as alt text; one not taken stays with why, and publishing still waits for it", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await setUp();
  const { number } = await draft();
  browserUse.next({ unreached: { "shot-2.png": "There's no Reports page in the menu." } });
  const run = await call(takeChangelogScreenshots, as(), { number });
  // Only the lines of their own were asked for: the one inside a sentence has no place an image could take.
  expect(browserUse.runs.at(-1)!.body.task).toContain("shot-1.png: The billing page\nshot-2.png: The reports page\n\n");
  expect(run.screenshots.map((shot) => shot.show)).toEqual(["The billing page", "The reports page"]);

  const entry = await saved(number);
  const content = (entry.content as Doc).content!;
  const image = content.find((block) => block.type === "image")!;
  const media = await prisma.screenshot.findFirstOrThrow({ where: { runId: run.id, position: 0 }, select: { image: { select: { id: true, width: true, height: true } } } });
  expect(image.attrs).toEqual({ mediaId: media.image!.id, width: "100", align: "center", alt: "The screen: The billing page", w: media.image!.width, h: media.image!.height });
  expect(content.map((block) => block.type)).toEqual(["paragraph", "image", "paragraph", "paragraph", "paragraph"]);
  expect(entry.body).not.toContain("[Screenshot: The billing page]");
  expect(entry.body).toContain("[Screenshot: The reports page]");

  // The editor: the line not taken, with why; the run charged as any screenshot run, and the next one estimated from it.
  const shown = await entryScreenshots(project.id, entry);
  expect(shown).toMatchObject({ asked: 1, available: true, running: null, failed: [{ show: "The reports page", reason: "There's no Reports page in the menu." }], credits: true });
  expect(shown.estimate).toBeCloseTo(4.19 / 2, 6);
  expect((await creditBalance(project.id)).balance).toBeCloseTo(10 - 4.19, 6);
  await expect(call(publishChangelogEntry, as(), { number })).rejects.toMatchObject({ status: 409, code: "markers" });
});

test("a line changed or taken out while the screenshots are taken is left as the team saved it", { timeout: 60_000 }, async () => {
  await setUp();
  const { number } = await draft(["[Screenshot: The billing page]", "[Screenshot: The reports page]", "[Screenshot: The team page]"].join("\n\n"));
  browserUse.next({ stuck: true });
  const before = browserUse.runs.length;
  const taking = call(takeChangelogScreenshots, as(), { number });
  await vi.waitFor(() => expect(browserUse.runs).toHaveLength(before + 1), { timeout: 30_000, interval: 100 });
  // Edited meanwhile: one line reworded, one taken out.
  await call(updateChangelogEntry, as(), { number, body: ["[Screenshot: The billing page, with invoices]", "[Screenshot: The reports page]"].join("\n\n") });
  browserUse.release();
  const run = await taking;
  expect(run.screenshots.map((shot) => shot.state)).toEqual(["taken", "taken", "taken"]);

  const entry = await saved(number);
  const content = (entry.content as Doc).content!;
  expect(content.map((block) => block.type)).toEqual(["paragraph", "image"]);
  expect(entry.body).toContain("[Screenshot: The billing page, with invoices]");
  // Nothing to say about the reworded line: it wasn't asked for as it is now.
  expect((await entryScreenshots(project.id, entry)).failed).toEqual([]);
});

test("two lines asking for the same screenshot each get one", async () => {
  await setUp();
  const { number } = await draft(["[Screenshot: The dashboard]", "Between.", "[screenshot : The dashboard ]"].join("\n\n"));
  await call(takeChangelogScreenshots, as(), { number });
  const content = ((await saved(number)).content as Doc).content!;
  expect(content.map((block) => block.type)).toEqual(["image", "paragraph", "image"]);
  expect(content[0]!.attrs!.mediaId).not.toBe(content[2]!.attrs!.mediaId);
});

test("refused without Screenshots set up, without lines to fill, without a key, or for an entry that isn't there", async () => {
  const { number } = await draft();
  await expect(call(takeChangelogScreenshots, as(), { number })).rejects.toMatchObject({ status: 409, code: "not_set_up" });
  expect(await entryScreenshots(project.id, await saved(number))).toMatchObject({ asked: 2, available: "not_set_up", credits: false, estimate: null });
  await setUp();
  const plain = await draft("Nothing to show.");
  await expect(call(takeChangelogScreenshots, as(), { number: plain.number })).rejects.toMatchObject({ status: 409, code: "no_markers" });
  await expect(call(takeChangelogScreenshots, as(), { number: 999 })).rejects.toMatchObject({ status: 404 });
  vi.stubEnv("BROWSER_USE_API_KEY", "");
  await expect(call(takeChangelogScreenshots, as(), { number })).rejects.toMatchObject({ status: 503 });
  expect(await entryScreenshots(project.id, await saved(number))).toMatchObject({ available: false });
  expect(await prisma.screenshotRun.count({ where: { projectId: project.id } })).toBe(0);
});

test("an image the agent didn't describe gets what its line asked for as alt text, never none", async () => {
  await setUp();
  const { number } = await draft("[Screenshot: The billing page]");
  browserUse.next({ output: { signedIn: true, shots: [{ file: "shot-1.png", reached: true }] } });
  await call(takeChangelogScreenshots, as(), { number });
  expect(((await saved(number)).content as Doc).content).toMatchObject([{ type: "image", attrs: { alt: "The billing page" } }]);
});

test("a run whose job didn't place its screenshots (an older worker's) has them placed by the editor's read, once", async () => {
  await setUp();
  const { number } = await draft("[Screenshot: The billing page]");
  const run = await call(takeChangelogScreenshots, as(), { number });
  // As an older worker leaves it: done, nothing placed.
  await prisma.screenshotRun.update({ where: { id: run.id }, data: { placedAt: null } });
  await call(updateChangelogEntry, as(), { number, body: "[Screenshot: The billing page]" });
  const { id } = await saved(number);
  expect(await placeLeftoverScreenshots(id)).toBe(true);
  expect(((await saved(number)).content as Doc).content!.map((block) => block.type)).toEqual(["image"]);
  // The same line written again later isn't filled again by that run.
  await call(updateChangelogEntry, as(), { number, body: "[Screenshot: The billing page]" });
  expect(await placeLeftoverScreenshots(id)).toBe(false);
  expect(await placeChangelogScreenshots(run.id)).toBe(0);
  expect((await saved(number)).body).toBe("[Screenshot: The billing page]");
});

test("a run still running isn't placed (a second delivery of its job leaves it to the first), and says it's running", { timeout: 60_000 }, async () => {
  await setUp();
  const { number } = await draft("[Screenshot: The billing page]");
  browserUse.next({ stuck: true });
  const before = browserUse.runs.length;
  const taking = call(takeChangelogScreenshots, as(), { number });
  await vi.waitFor(() => expect(browserUse.runs).toHaveLength(before + 1), { timeout: 30_000, interval: 100 });
  const running = await prisma.screenshotRun.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  expect(await placeChangelogScreenshots(running.id)).toBe(0);
  expect(await entryScreenshotsRunning(project.id, number)).toMatchObject({ running: true });
  expect(await entryScreenshots(project.id, await saved(number))).toMatchObject({ running: 1 });
  browserUse.release();
  await taking;
  // Done, and the entry saved again with its screenshot: the editor knows its form is out of date.
  const done = await entryScreenshotsRunning(project.id, number);
  expect(done).toMatchObject({ running: false });
  expect(done.savedAt).toBe((await saved(number)).updatedAt.toISOString());
  expect(((await saved(number)).content as Doc).content!.map((block) => block.type)).toEqual(["image"]);
});

test("a placement that waited on the entry while the run went on reads its screenshots once it's ended, so none are lost", { timeout: 60_000 }, async () => {
  await setUp();
  const { number } = await draft(["[Screenshot: The billing page]", "[Screenshot: The reports page]"].join("\n\n"));
  const { id: entryId } = await saved(number);
  browserUse.next({ stuck: true });
  const before = browserUse.runs.length;
  const taking = call(takeChangelogScreenshots, as(), { number });
  await vi.waitFor(() => expect(browserUse.runs).toHaveLength(before + 1), { timeout: 30_000, interval: 100 });
  const { id: runId } = await prisma.screenshotRun.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  // The entry held (a save, say): a second placement (a duplicate delivery of the job) starts while the run is going and
  // waits on it, first in line; meanwhile the run ends with both screenshots.
  let release!: () => void;
  const holding = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM changelog_entry WHERE id = ${entryId} FOR UPDATE`;
    await new Promise<void>((resolve) => (release = resolve));
  }, { timeout: 60_000 });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const duplicate = placeChangelogScreenshots(runId);
  await untilWaitingOnLock(1);
  browserUse.release();
  await vi.waitFor(async () => expect((await prisma.screenshotRun.findUniqueOrThrow({ where: { id: runId } })).state).toBe("DONE"), { timeout: 30_000, interval: 100 });
  release();
  await holding;
  // The duplicate claimed it, once it had ended, and placed both; the job's own placement found it claimed.
  expect(await duplicate).toBe(2);
  await taking;
  expect(((await saved(number)).content as Doc).content!.map((block) => block.type)).toEqual(["image", "image"]);
});

test("the editor's question says running until the run's screenshots are placed, placing one an older worker left", async () => {
  await setUp();
  const { number } = await draft("[Screenshot: The billing page]");
  const run = await call(takeChangelogScreenshots, as(), { number });
  // Ended, not placed yet (its job about to, or an older worker's that never will), the text as it was.
  await prisma.screenshotRun.update({ where: { id: run.id }, data: { placedAt: null } });
  await call(updateChangelogEntry, as(), { number, body: "[Screenshot: The billing page]" });
  const asked = await entryScreenshotsRunning(project.id, number);
  // Placed by the question itself: done, and the saved time is the placement's, so the editor knows the text changed.
  const entry = await saved(number);
  expect((entry.content as Doc).content!.map((block) => block.type)).toEqual(["image"]);
  expect(asked).toEqual({ running: false, savedAt: entry.updatedAt.toISOString() });
});

test("the editor's save of text shown before screenshots went in is refused, not putting their lines back; one that took none isn't", async () => {
  await setUp();
  actAs(owner);
  const { number } = await draft("Billing.\n\n[Screenshot: The billing page]");
  const shown = await saved(number);
  const form = (seenAt: Date, text = "Billing, edited.\n\n[Screenshot: The billing page]") => {
    const data = new FormData();
    data.set("title", "November");
    data.set("content", JSON.stringify({ type: "doc", content: text.split("\n\n").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })) }));
    data.set("screenshotsSeenAt", seenAt.toISOString());
    return data;
  };
  await call(takeChangelogScreenshots, as(), { number });
  expect(await saveChangelogEntry(project.slug, number, {}, form(shown.updatedAt))).toEqual({ error: SCREENSHOTS_PLACED });
  expect(((await saved(number)).content as Doc).content!.map((block) => block.type)).toEqual(["paragraph", "image"]);
  // Shown after they went in: saved.
  expect(await saveChangelogEntry(project.slug, number, {}, form((await saved(number)).updatedAt, "Billing, edited."))).toEqual({});

  // A run that put nothing in holds no save back.
  const other = await draft("[Screenshot: a screen that isn't there]");
  const before = await saved(other.number);
  browserUse.next({ unreached: { "shot-1.png": "Not in the menu." } });
  await call(takeChangelogScreenshots, as(), { number: other.number });
  expect(await saveChangelogEntry(project.slug, other.number, {}, form(before.updatedAt, "Rewritten."))).toEqual({});
});

test("a save isn't held back by a worker's clock: only a placement over the version the text was shown from counts", async () => {
  await setUp();
  actAs(owner);
  const { number } = await draft("Billing.\n\n[Screenshot: The billing page]");
  const run = await call(takeChangelogScreenshots, as(), { number });
  // The worker's clock a day fast: its placement's time, and the entry's version it wrote, are in the future.
  const ahead = new Date(Date.now() + 86_400_000);
  await prisma.screenshotRun.update({ where: { id: run.id }, data: { placedAt: ahead } });
  const { id } = await saved(number);
  await prisma.$executeRaw`UPDATE changelog_entry SET "updatedAt" = ${ahead} WHERE id = ${id}`;
  const save = async (text: string) => {
    const data = new FormData();
    data.set("title", "November");
    data.set("content", JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }));
    data.set("screenshotsSeenAt", (await saved(number)).updatedAt.toISOString());
    return saveChangelogEntry(project.slug, number, {}, data);
  };
  // Shown after the placement, then again after that save (its version by the web's clock, before the worker's): both saved.
  expect(await save("Shown after.")).toEqual({});
  expect(await save("And again.")).toEqual({});
});

test("the editor opened between a run's end and its placement shows it going, so it asks until it's placed", async () => {
  await setUp();
  const { number } = await draft("[Screenshot: The billing page]");
  const run = await call(takeChangelogScreenshots, as(), { number });
  await prisma.screenshotRun.update({ where: { id: run.id }, data: { placedAt: null } });
  expect(await entryScreenshots(project.id, await saved(number))).toMatchObject({ running: 1, ran: false, failed: [] });
});

test("a line over 500 characters is refused whole, never cut short to match another alike up to there", async () => {
  await setUp();
  const start = "a".repeat(500);
  const { number } = await draft(`[Screenshot: ${start} first]\n\n[Screenshot: ${start} second]`);
  await expect(call(takeChangelogScreenshots, as(), { number })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Keep each screenshot line under 500 characters") });
  expect(await prisma.screenshotRun.count({ where: { projectId: project.id } })).toBe(0);
});
