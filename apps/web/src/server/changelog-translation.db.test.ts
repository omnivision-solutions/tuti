import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { ANNOUNCEMENT_WAITS_MS, handlers, languageTranslationsDone, placeChangelogScreenshots, PRODUCT_SETTING_CHANGED, setChangelogLine, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Changelog translations (docs/plan.md L16): the same machinery as articles' (L6), and the announcement's wait. */

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
beforeEach(async () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const log = { info: () => {}, warn: () => {} };
const languages = async (input: Parameters<typeof updateLanguages.run>[1]) => {
  const result = await call(updateLanguages, as(), input);
  await languageTranslationsDone();
  return result;
};

const TITLE = "Dark mode";
const BODY = "Switch themes from your profile menu.";

/** A reply translating every segment of an entry (`title`, `body`) with `[tag] ` before each one's text. */
function reply(tag: string, title = TITLE, body = BODY) {
  const { segments } = segmentsOf(translationSource({ title, body, content: null }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
}

const idOf = async (number: number) => (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number }, select: { id: true } })).id;

/** A draft entry, and a subscriber who confirmed before it's published. */
async function draft() {
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entry = { number: created.number, id: await idOf(created.number) };
  const email = `e2e-reader-${project.slug}@example.com`;
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email, confirmedAt: new Date(Date.now() - 60_000) } });
  return { entry, email };
}
const translation = (language = "de") => prisma.changelogTranslation.findFirstOrThrow({ where: { projectId: project.id, language } });
const entryEmails = (email: string) => mailbox.emails.filter((message) => message.to.includes(email) && message.subject.includes(TITLE));

test("publishing an entry translates it into each language kept up to date, its title and text, charged as Translation", async () => {
  await languages({ languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[de] Dark mode", body: "[de] Switch themes from your profile menu.", error: null, automatic: true });
  expect(model.requests[0]!.system).toContain("changelog");
  // Manual for new pages: no version is made.
  expect(await prisma.changelogTranslation.count({ where: { projectId: project.id, language: "fr" } })).toBe(0);
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } })).toEqual([{ feature: "translation" }]);

  // Its title edited: translated again, the unchanged text from memory (only the title is sent).
  model.reply(JSON.stringify({ segments: { "1": "[de] Dunkler Modus" } }));
  await call(updateChangelogEntry, as(), { number: entry.number, title: "Dark mode is here" });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[de] Dunkler Modus", body: "[de] Switch themes from your profile menu." });
  expect(model.requests).toHaveLength(2);
});

test("its announcement waits for its translations kept up to date, then goes once they're in", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, email } = await draft();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(reply("de"), () => held);
  await call(publishChangelogEntry, as(), { number: entry.number, emailSubscribers: true });
  // Translating: nothing sent yet, and still due.
  expect(entryEmails(email)).toHaveLength(0);
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).subscribersEmailDueAt).not.toBeNull();
  release();
  await languageTranslationsDone();
  await vi.waitFor(() => expect(entryEmails(email)).toHaveLength(1));
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).subscribersEmailDueAt).toBeNull();
});

test("past its wait, the announcement goes untranslated; a translation that failed never holds it", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, email } = await draft();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(reply("de"), () => held);
  await call(publishChangelogEntry, as(), { number: entry.number, emailSubscribers: true });
  expect(entryEmails(email)).toHaveLength(0);
  // Due longer than the wait (the safety net's next run): it goes, its translation still on its way.
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailDueAt: new Date(Date.now() - ANNOUNCEMENT_WAITS_MS - 1000) } });
  await handlers.changelogEmailed({ entryId: entry.id }, log);
  expect(entryEmails(email)).toHaveLength(1);
  release();
  await languageTranslationsDone();

  // Another entry, its translation failing: sent at once.
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const second = { number: created.number, id: await idOf(created.number) };
  for (let i = 0; i < 2; i++) model.fail(500);
  await call(publishChangelogEntry, as(), { number: second.number, emailSubscribers: true });
  await languageTranslationsDone();
  await vi.waitFor(() => expect(entryEmails(email)).toHaveLength(2));
  expect((await prisma.changelogTranslation.findFirstOrThrow({ where: { entryId: second.id } })).error).not.toBeNull();
});

test("the product setting changing marks the team's own entries behind; an entry kept up to date takes the new setting on its next translation; the retry job takes entries too", async () => {
  await languages({ languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  await prisma.changelogTranslation.create({ data: { entryId: entry.id, projectId: project.id, language: "fr", automatic: false, title: "Mode sombre", publishedAt: new Date() } });

  // Not retranslated in bulk (Settings doesn't count entries in what it confirms yet): the team's own are marked behind.
  await languages({ languages: [{ code: "de", productAvailable: true }, { code: "fr", productAvailable: true }] });
  expect(model.requests).toHaveLength(1);
  expect(Object.values((await translation("fr")).behind as Record<string, string>)).toContain(PRODUCT_SETTING_CHANGED);
  expect(await call(retranslateLanguage, as(), { code: "de" })).toEqual({ queued: 0 });
  // Edited, it's translated under the new setting, nothing reused from the old one.
  model.reply(reply("on", "Dark mode is here"));
  await call(updateChangelogEntry, as(), { number: entry.number, title: "Dark mode is here" });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[on] Dark mode is here", body: "[on] Switch themes from your profile menu.", productAvailable: true });
  expect(model.requests.at(-1)!.system).toContain("The product is available in German");

  // A version that couldn't be translated, its wait over: the retry job translates it.
  await prisma.changelogTranslation.updateMany({ where: { entryId: entry.id, language: "de" }, data: { error: "Out of credits", retryAt: new Date(Date.now() - 1000), retranslate: { increment: 1 } } });
  model.reply(reply("retried", "Dark mode is here"));
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[retried] Dark mode is here", error: null, retryAt: null });
});

test("a translation ending long after an announcement was due doesn't send it: that's the email safety net's, which gives up after two days", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, email } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  // Due for weeks (its sends kept failing): a translation ending now leaves it be.
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) } });
  model.reply(JSON.stringify({ segments: { "1": "[de] Dunkler Modus" } }));
  await call(updateChangelogEntry, as(), { number: entry.number, title: "Dark mode is here" });
  await languageTranslationsDone();
  expect(entryEmails(email)).toHaveLength(0);
});

test("an entry translating as the product setting changes is translated again under the new one", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  // Its first translation finds the setting changed as it answers: it writes nothing, and goes again.
  model.reply(reply("stale"), () => call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] }));
  model.reply(reply("on"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[on] Dark mode", productAvailable: true });
  expect(model.requests).toHaveLength(2);
});

test("screenshots placed in a published entry's text bring its translations up to date", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  // A line asking for a screenshot in its published text (as an older entry can have), and a finished run's screenshot for it.
  const marked = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: BODY }] }, { type: "paragraph", content: [{ type: "text", text: "[Screenshot: The theme menu]" }] }] };
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { content: marked, body: `${BODY}\n\n[Screenshot: The theme menu]` } });
  const image = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 1000, status: "READY", width: 1200, height: 800 } });
  const run = await prisma.screenshotRun.create({ data: { projectId: project.id, changelogEntryId: entry.id, state: "DONE" } });
  await prisma.screenshot.create({ data: { projectId: project.id, runId: run.id, position: 0, show: "The theme menu", imageId: image.id } });
  // Placed: its text changed (the image's description is new to translate; the rest comes from memory).
  const placed = { type: "doc" as const, content: [marked.content[0]!, { type: "image", attrs: { mediaId: image.id, width: "100", align: "center", alt: "The theme menu", w: 1200, h: 800 } }] };
  const { segments } = segmentsOf(translationSource({ title: TITLE, body: "", content: placed }).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  expect(await placeChangelogScreenshots(run.id)).toBe(1);
  await languageTranslationsDone();
  const de = await translation();
  expect(JSON.stringify(de.content)).toContain("[de] The theme menu");
  expect(de.body).not.toContain("Screenshot");
  expect(model.requests).toHaveLength(2);
});

test("a sample entry's translation ending never announces it", async () => {
  await languages({ languages: [{ code: "de" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  // Home's sample content, published and (somehow) due: a translation ending queues nothing for it.
  await prisma.changelogEntry.update({ where: { id: entryId }, data: { sample: true, publishedAt: new Date(), subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "de" } });
  const emailed = vi.spyOn(handlers, "changelogEmailed");
  try {
    await handlers.translateChangelogEntry({ entryId, language: "de" }, log);
    expect(emailed).not.toHaveBeenCalled();
  } finally {
    emailed.mockRestore();
  }
});

test("screenshots placed are kept even when queuing the entry's translations then fails", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  const marked = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "[Screenshot: The theme menu]" }] }] };
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { content: marked, body: "[Screenshot: The theme menu]" } });
  const image = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 1000, status: "READY", width: 1200, height: 800 } });
  const run = await prisma.screenshotRun.create({ data: { projectId: project.id, changelogEntryId: entry.id, state: "DONE" } });
  await prisma.screenshot.create({ data: { projectId: project.id, runId: run.id, position: 0, show: "The theme menu", imageId: image.id } });
  // Reading the entry to queue its translations fails once (the database, briefly).
  const reading = vi.spyOn(prisma.changelogEntry, "findFirst").mockRejectedValueOnce(new Error("database blip"));
  try {
    expect(await placeChangelogScreenshots(run.id)).toBe(1);
  } finally {
    reading.mockRestore();
  }
  const placed = await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } });
  expect((placed.content as { content: { type: string }[] }).content.map((block) => block.type)).toEqual(["image"]);
  // Nothing set the German version's safety net; the retry job finds it behind and brings it up to date.
  const { segments } = segmentsOf(translationSource(placed).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect((await translation()).sourceHash).toBe(translationSource(placed).hash);
  expect(JSON.stringify((await translation()).content)).toContain("[de] The theme menu");
});

test("an announcement whose translation ends after the wait is sent by the email safety net (every 10 minutes, inline too)", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, email } = await draft();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(reply("de"), () => held);
  await call(publishChangelogEntry, as(), { number: entry.number, emailSubscribers: true });
  expect(entryEmails(email)).toHaveLength(0);
  // The translation ends long after the wait: it no longer sends the announcement itself.
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { subscribersEmailDueAt: new Date(Date.now() - ANNOUNCEMENT_WAITS_MS - 60_000) } });
  release();
  await languageTranslationsDone();
  expect(entryEmails(email)).toHaveLength(0);
  // The safety net (Hatchet's cron, the server's own timer inline) sends it, translated by then.
  await handlers.resubmitChangelogEmails({}, log);
  await vi.waitFor(() => expect(entryEmails(email)).toHaveLength(1));
});

test("an Autopilot line approved into a published entry brings its translations up to date", async () => {
  await languages({ languages: [{ code: "de" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  const pr = { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", title: "Add dark mode" };
  await prisma.changelogEntryPullRequest.create({ data: { entryId, ...pr } });
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: created.number });
  await languageTranslationsDone();
  // The line goes into the published entry (as an approved CHANGELOG_LINE writes it): its German follows.
  const line = "Dark mode, everywhere.";
  // Only the new bullet is asked (the rest comes from memory), its link kept.
  model.reply(JSON.stringify({ segments: { "3": `<a1>[de] ${line}</a1>` } }));
  expect(await setChangelogLine(project.id, pr, line)).toMatchObject({ number: created.number });
  await languageTranslationsDone();
  expect((await translation()).body).toContain(`[de] ${line}`);
});
