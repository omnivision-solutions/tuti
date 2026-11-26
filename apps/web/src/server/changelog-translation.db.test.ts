import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { ANNOUNCEMENT_WAITS_MS, handlers, languageTranslationsDone, placeChangelogScreenshots, PRODUCT_SETTING_CHANGED, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { actAs, createProject, onPortal, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";
import { mailbox } from "@/test/mailbox";

import { subscribeToChangelog } from "./changelog-subscribe";
import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { updateEmailPreferences } from "./operations/email-preferences";
import { call } from "./operations/run";
import { chooseLanguage } from "./reader-language";

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

/** A confirmed subscriber in `language` (null: the default language's). */
const subscriber = (email: string, language: string | null) =>
  prisma.changelogSubscriber.create({ data: { projectId: project.id, email, language, confirmedAt: new Date(Date.now() - 60_000) } });

test("each subscriber gets an entry in their language where its version there is current, else in the default language", async () => {
  await languages({ languages: [{ code: "de", live: true }, { code: "fr", live: true, newPages: "manual" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const german = `e2e-de-${project.slug}@example.com`;
  const english = `e2e-en-${project.slug}@example.com`;
  const french = `e2e-fr-${project.slug}@example.com`;
  await subscriber(german, "de");
  await subscriber(english, null);
  // French is the team's to write, and they haven't: the default language's.
  await subscriber(french, "fr");
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await languageTranslationsDone();
  await vi.waitFor(() => expect(mailbox.emails.filter((m) => [german, english, french].some((a) => m.to.includes(a)))).toHaveLength(3));
  const to = (address: string) => mailbox.emails.find((m) => m.to.includes(address))!;
  expect(to(german).subject).toContain("[de] Dark mode");
  expect(to(german).text).toContain("[de] Switch themes from your profile menu.");
  expect(to(english).subject).toContain(TITLE);
  expect(to(english).text).toContain(BODY);
  expect(to(french).subject).not.toContain("[");
});

test("a German version behind the entry (its translation still to come, past the wait) isn't sent: the default language's is", async () => {
  await languages({ languages: [{ code: "de", live: true }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  const german = `e2e-de-${project.slug}@example.com`;
  await subscriber(german, "de");
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: created.number });
  await languageTranslationsDone();
  // Edited, its new translation held; then emailed past the wait.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(JSON.stringify({ segments: { "1": "[de] Dunkler Modus" } }), () => held);
  await call(updateChangelogEntry, as(), { number: created.number, title: "Dark mode is here" });
  await prisma.changelogEntry.update({ where: { id: entryId }, data: { subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date(Date.now() - ANNOUNCEMENT_WAITS_MS - 1000) } });
  await handlers.changelogEmailed({ entryId }, log);
  expect(mailbox.emails.find((m) => m.to.includes(german))!.subject).toContain("Dark mode is here");
  release();
  await languageTranslationsDone();
});

test("subscribing on a language's page keeps that language; a signed-in reader's switch moves their subscription to theirs", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  await onPortal(reader, project);
  actAs(reader);
  const subscribe = (email: string) => {
    const form = new FormData();
    form.set("email", email);
    return subscribeToChangelog(project.slug, form);
  };
  const languageOf = async (email: string) => (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).language;
  request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de" };
  try {
    expect(await subscribe(reader.email)).toEqual({ sentTo: reader.email });
    expect(await languageOf(reader.email)).toBe("de");
    // From the default language's pages: null (the default's).
    request.headers = { "x-tuti-language": "en", "x-tuti-language-prefix": "" };
    const other = `e2e-other-${project.slug}@example.com`;
    expect(await subscribe(other)).toEqual({ sentTo: other });
    expect(await languageOf(other)).toBeNull();
  } finally {
    request.headers = {};
  }
  // Their switch moves their own subscription, and no one else's.
  expect(await chooseLanguage(project.slug, "en")).toEqual({});
  expect(await languageOf(reader.email)).toBeNull();
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  expect(await languageOf(reader.email)).toBe("de");
  expect(await languageOf(`e2e-other-${project.slug}@example.com`)).toBeNull();
});

test("a version the team wrote goes as it is, even behind the entry; an offline language's never goes", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", newPages: "manual" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  // The team's own German (made from an older text: still theirs to send), and French, not live.
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "de", automatic: false, title: "Dunkler Modus", body: "Unser Text.", sourceHash: "older", publishedAt: new Date() } });
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "fr", automatic: false, title: "Mode sombre", body: "Notre texte.", publishedAt: new Date() } });
  const german = `e2e-de-${project.slug}@example.com`;
  const french = `e2e-fr-${project.slug}@example.com`;
  await subscriber(german, "de");
  await subscriber(french, "fr");
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await vi.waitFor(() => expect(mailbox.emails.filter((m) => [german, french].some((a) => m.to.includes(a)))).toHaveLength(2));
  expect(mailbox.emails.find((m) => m.to.includes(german))!.text).toContain("Unser Text.");
  const toFrench = mailbox.emails.find((m) => m.to.includes(french))!;
  expect(toFrench.subject).toContain(TITLE);
  expect(toFrench.text).toContain(BODY);
});

test("subscribing again sets the language of the page it's done on; a reader's own Account switch subscribes them in their language", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const subscribe = (email: string) => {
    const form = new FormData();
    form.set("email", email);
    return subscribeToChangelog(project.slug, form);
  };
  const languageOf = async (email: string) => (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).language;
  const address = `e2e-again-${project.slug}@example.com`;
  try {
    request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de" };
    await subscribe(address);
    expect(await languageOf(address)).toBe("de");
    // Not confirmed yet, asked again from the default language's page: the default's.
    request.headers = { "x-tuti-language": "en", "x-tuti-language-prefix": "" };
    await subscribe(address);
    expect(await languageOf(address)).toBeNull();
    // Confirmed (and since opted out, so asking again sends a link): a typed-in address leaves its language be.
    await prisma.changelogSubscriber.updateMany({ where: { projectId: project.id, email: address }, data: { confirmedAt: new Date(), language: "de", unsubscribedAt: new Date() } });
    await subscribe(address);
    expect(await languageOf(address)).toBe("de");
  } finally {
    request.headers = {};
  }
  // A signed-in reader who reads in German turns the changelog on from their Account: in German.
  const reader = await signUp("Reader");
  await onPortal(reader, project);
  actAs(reader);
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  expect(await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true })).toMatchObject({ changelog: true });
  expect(await languageOf(reader.email)).toBe("de");
});

test("a reader whose address isn't proven theirs moves nobody's subscription with their switch", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader", undefined, { verified: false });
  await subscriber(reader.email, null);
  await onPortal(reader, project);
  actAs(reader);
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email } })).language).toBeNull();
});

test("a version the team wrote has its own images in its email", async () => {
  // Media storage, which images in emails are served from.
  const s3 = await startS3Fake();
  onTestFinished(() => s3.close());
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  // Their German has a screenshot of its own, which the source doesn't.
  const image = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 1000, status: "READY", width: 1200, height: 800 } });
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unser Text." }] }, { type: "image", attrs: { mediaId: image.id, alt: "Das Menü", w: 1200, h: 800 } }] };
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "de", automatic: false, title: "Dunkler Modus", body: "Unser Text.", content, publishedAt: new Date() } });
  const german = `e2e-de-${project.slug}@example.com`;
  await subscriber(german, "de");
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await vi.waitFor(() => expect(mailbox.emails.filter((m) => m.to.includes(german))).toHaveLength(1));
  const html = mailbox.emails.find((m) => m.to.includes(german))!.html;
  expect(html).toContain('alt="Das Menü"');
  expect(html).toContain(image.id);
});

test("a reader whose unconfirmed subscription predates their language takes it as they turn the changelog on from Account", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  // Asked for on the default language's page before, not confirmed.
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email: reader.email.toLowerCase() } });
  await onPortal(reader, project);
  actAs(reader);
  await prisma.user.update({ where: { id: reader.id }, data: { language: "de" } });
  expect(await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true })).toMatchObject({ changelog: true });
  expect(await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).toMatchObject({ language: "de" });
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
  expect(((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).content as { content: { type: string }[] }).content.map((block) => block.type)).toEqual(["image"]);
});
