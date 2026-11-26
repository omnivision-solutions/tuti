import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { creditBalance, grantCredits, placeChangelogScreenshots } from "@tuti/jobs";
import { type BrowserUseFake, creditsOn, type S3Fake, startBrowserUseFake, startS3Fake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { entryScreenshots, entryScreenshotsRunning, placeLeftoverScreenshots, takeChangelogScreenshots, updateScreenshotSettings } from "@/server/operations/screenshots";
import { createProject, signUp, type TestUser } from "@/test/helpers";

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
const saved = (number: number) => prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number }, select: { id: true, body: true, content: true } });

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
  expect(await entryScreenshotsRunning(project.id, number)).toBe(true);
  expect(await entryScreenshots(project.id, await saved(number))).toMatchObject({ running: 1 });
  browserUse.release();
  await taking;
  expect(await entryScreenshotsRunning(project.id, number)).toBe(false);
  expect(((await saved(number)).content as Doc).content!.map((block) => block.type)).toEqual(["image"]);
});
