import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { ANNOUNCEMENT_WAITS_MS, handlers, languageTranslationsDone, placeScreenshots, PRODUCT_SETTING_CHANGED, setChangelogLine, translationSource } from "@tuti/jobs";
import { billingFile, type ModelFake, startModelFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { actAs, createProject, onPortal, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";
import { mailbox } from "@/test/mailbox";

import { subscribeToChangelog } from "./changelog-subscribe";
import { createChangelogEntry, editChangelogSection, publishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { getLanguages, retranslateLanguage, updateLanguages } from "./operations/languages";
import { setEmailPreference } from "./email-preferences";
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
  // Its first board out of the way: boards are translated too (docs/plan.md L14), so this file's replies stay its own pages'.
  await prisma.board.deleteMany({ where: { projectId: project.id } });
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

test("the product setting changing retranslates the entries kept up to date and marks the team's own behind; Retranslate and the retry job take entries too", async () => {
  await languages({ languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  await prisma.changelogTranslation.create({ data: { entryId: entry.id, projectId: project.id, language: "fr", automatic: false, title: "Mode sombre", publishedAt: new Date() } });

  // The switch: German's entry, kept up to date, is translated again under it (nothing reused); the team's French is marked behind.
  model.reply(reply("on"));
  await languages({ languages: [{ code: "de", productAvailable: true }, { code: "fr", productAvailable: true }] });
  expect(model.requests).toHaveLength(2);
  expect(await translation()).toMatchObject({ title: "[on] Dark mode", productAvailable: true });
  expect(model.requests.at(-1)!.system).toContain("The product is available in German");
  expect(Object.values((await translation("fr")).behind as Record<string, string>)).toContain(PRODUCT_SETTING_CHANGED);
  // Retranslate: German's entries too, anew.
  model.reply(reply("again"));
  expect(await call(retranslateLanguage, as(), { code: "de" })).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[again] Dark mode" });

  // A version that couldn't be translated, its wait over: the retry job translates it.
  await prisma.changelogTranslation.updateMany({ where: { entryId: entry.id, language: "de" }, data: { error: "Out of credits", retryAt: new Date(Date.now() - 1000), retranslate: { increment: 1 } } });
  model.reply(reply("retried"));
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[retried] Dark mode", error: null, retryAt: null });
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
  expect(await placeScreenshots(run.id)).toBe(1);
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
  // Its links in their language: the German version's under /de (the entry, its title and images, the subscription), the
  // default language's own for English and French's fallback.
  const page = `/changelog/${created.number}"`;
  expect(to(german).html).toContain(`/de${page}`);
  expect(to(german).html).toMatch(/\/de\/changelog\/subscription\?token=/);
  const links = (address: string) => to(address).html.match(/https?:\/\/[^"'\s<>]*\/changelog\/[^"'\s<>]*/g) ?? [];
  expect(links(german).length).toBeGreaterThan(1);
  expect(links(german).filter((link) => !link.includes("/de/changelog/"))).toEqual([]);
  // The email's own words in each one's language (L5), French too, though its entry falls back: so French's Unsubscribe
  // opens the subscription's page in French, its entry the default language's.
  expect(to(german).text).toContain("Neu ·");
  expect(to(german).text).toContain("Abbestellen");
  expect(to(french).text).toContain("Nouveau ·");
  // Its entry, not in French, marked as the default language's inside the French email.
  expect(to(french).html).toMatch(/<html[^>]* lang="fr"/);
  expect(to(french).html).toMatch(/<div lang="en"><h1[^>]*>Dark mode<\/h1>/);
  expect(to(french).html).toMatch(/\/fr\/changelog\/subscription\?token=/);
  expect(to(french).html).not.toContain(`/fr${page}`);
  expect(to(english).text).toContain("New ·");
  for (const address of [english, french]) {
    expect(to(address).html).toContain(page);
    expect(to(address).html).not.toMatch(address === french ? /\/de\/changelog/ : /\/(de|fr)\/changelog/);
  }
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

/** A published entry in German whose placed screenshot changed its text, queuing its translations then failing once. */
async function placedWithFailedQueuing() {
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
    expect(await placeScreenshots(run.id)).toBe(1);
  } finally {
    reading.mockRestore();
  }
  const placed = await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } });
  // The placement stands; the entry is marked for the retry job.
  expect((placed.content as { content: { type: string }[] }).content.map((block) => block.type)).toEqual(["image"]);
  expect(placed.translationsQueueFailedAt).not.toBeNull();
  // Fresh, it's left to the queuing that set it (that may still be under way): the retry job takes it once that's past.
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  await prisma.changelogEntry.update({ where: { id: entry.id }, data: { translationsQueueFailedAt: new Date(Date.now() - 2 * 60_000) } });
  const { segments } = segmentsOf(translationSource(placed).doc);
  return { entry, placed, reply: JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }) };
}

test("screenshots placed are kept even when queuing the entry's translations then fails, and the retry job brings them up to date", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, placed, reply: translated } = await placedWithFailedQueuing();
  model.reply(translated);
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect((await translation()).sourceHash).toBe(translationSource(placed).hash);
  expect(JSON.stringify((await translation()).content)).toContain("[de] The theme menu");
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).translationsQueueFailedAt).toBeNull();
  // Cleared: the next run has nothing to queue.
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
});

test("a language past the plan's limit (after a downgrade) isn't emailed in, as the portal doesn't serve it", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  // Pro: up to 3 languages, the default included: German and Spanish are served, French (added last) isn't.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
  for (const [i, code] of ["de", "es", "fr"].entries()) {
    await prisma.projectLanguage.create({ data: { projectId: project.id, code, live: true, automatic: false, createdAt: new Date(Date.now() - (3 - i) * 60_000) } });
  }
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const entryId = await idOf(created.number);
  for (const [code, title] of [["es", "Modo oscuro"], ["fr", "Mode sombre"]] as const) {
    await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: code, automatic: false, title, body: title, publishedAt: new Date() } });
  }
  const spanish = `e2e-es-${project.slug}@example.com`;
  const french = `e2e-fr-${project.slug}@example.com`;
  await subscriber(spanish, "es");
  await subscriber(french, "fr");
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await vi.waitFor(() => expect(mailbox.emails.filter((m) => [spanish, french].some((a) => m.to.includes(a)))).toHaveLength(2));
  expect(mailbox.emails.find((m) => m.to.includes(spanish))!.subject).toContain("Modo oscuro");
  expect(mailbox.emails.find((m) => m.to.includes(french))!.subject).toContain(TITLE);
});

test("a signed-in reader subscribing on the default language's page gets their saved language", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  await onPortal(reader, project);
  actAs(reader);
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  const form = new FormData();
  form.set("email", reader.email);
  request.headers = { "x-tuti-language": "en", "x-tuti-language-prefix": "" };
  try {
    expect(await subscribeToChangelog(project.slug, form)).toEqual({ sentTo: reader.email });
  } finally {
    request.headers = {};
  }
  expect((await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).language).toBe("de");
});

test("turning the changelog on from Account keeps an unconfirmed subscription's language when the reader has none saved", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  // Asked for on the German page before, not confirmed; the reader has no language saved.
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email: reader.email.toLowerCase(), language: "de" } });
  await onPortal(reader, project);
  actAs(reader);
  expect(await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true })).toMatchObject({ changelog: true });
  expect(await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).toMatchObject({ language: "de" });
});

test("turning the changelog on from Account takes the default when that's the language the reader saved", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  // Asked for on the German page before, not confirmed; the reader then picked English, the default.
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email: reader.email.toLowerCase(), language: "de" } });
  await prisma.user.update({ where: { id: reader.id }, data: { language: "en" } });
  await onPortal(reader, project);
  actAs(reader);
  expect(await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true })).toMatchObject({ changelog: true });
  expect(await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).toMatchObject({ language: null });
});

test("turning the changelog on from Account keeps an unconfirmed subscription's language when the reader's saved one isn't served here", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  // Asked for on the German page before, not confirmed; the reader's saved language (French, chosen on another portal) isn't one of this one's.
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email: reader.email.toLowerCase(), language: "de" } });
  await prisma.user.update({ where: { id: reader.id }, data: { language: "fr" } });
  await onPortal(reader, project);
  actAs(reader);
  expect(await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true })).toMatchObject({ changelog: true });
  expect(await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).toMatchObject({ language: "de" });
});

test("a reader with no language saved turning the changelog on from Account on a German page gets it in German, as the subscribe form would", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Reader");
  // On /de (a link, or the browser's language), nothing saved.
  await onPortal(reader, project);
  actAs(reader);
  request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de" };
  try {
    expect(await setEmailPreference(project.slug, "changelog", true)).not.toHaveProperty("error");
  } finally {
    request.headers = {};
  }
  expect(await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email: reader.email.toLowerCase() } })).toMatchObject({ language: "de", confirmedAt: expect.any(Date) });
});

test("the page's language the Account switch passes counts only where the portal is in it: an offline one leaves the subscription's, the default's is null", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: false, newPages: "manual" }] });
  const turnOn = async (name: string, language: "fr" | "en") => {
    const reader = await signUp(name);
    const email = reader.email.toLowerCase();
    // Asked for on the German page before, not confirmed; nothing saved.
    await prisma.changelogSubscriber.create({ data: { projectId: project.id, email, language: "de" } });
    await onPortal(reader, project);
    actAs(reader);
    await call(updateEmailPreferences, { actor: { kind: "user", userId: reader.id }, projectId: project.id }, { changelog: true, language });
    return (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).language;
  };
  expect(await turnOn("Reader One", "fr")).toBe("de");
  expect(await turnOn("Reader Two", "en")).toBeNull();
});

test("on an SSO portal, the switch moves the subscription at the sign-on's address, not the account's", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const reader = await signUp("Sam SSO");
  const signOn = `e2e-sso-${project.slug}@example.com`;
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: reader.id, userId: reader.id, email: signOn } });
  // A subscription at each address: the project's emails go to the sign-on's.
  await subscriber(reader.email.toLowerCase(), null);
  await subscriber(signOn, null);
  await onPortal(reader, project);
  actAs(reader);
  expect(await chooseLanguage(project.slug, "de")).toEqual({});
  const languageOf = async (email: string) => (await prisma.changelogSubscriber.findFirstOrThrow({ where: { projectId: project.id, email } })).language;
  expect(await languageOf(signOn)).toBe("de");
  expect(await languageOf(reader.email.toLowerCase())).toBeNull();
});


test("a failed entry is queued again by the retry job; a language added since gets it in its own bulk translating", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry, reply: translated } = await placedWithFailedQueuing();
  // French added: Settings counts entries, so it's translated as the language is added.
  model.reply(translated);
  await languages({ languages: [{ code: "de" }, { code: "fr" }] });
  expect(await prisma.changelogTranslation.count({ where: { entryId: entry.id, language: "fr", publishedAt: { not: null } } })).toBe(1);
  model.reply(translated);
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(JSON.stringify((await translation()).content)).toContain("[de] The theme menu");
  expect(model.requests).toHaveLength(3);
});

test("adding a language translates the published entries; their other changes (tags) and the retry job's run ask nothing more", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  model.reply(reply("fr"));
  await languages({ languages: [{ code: "de" }, { code: "fr" }] });
  expect(await translation("fr")).toMatchObject({ title: "[fr] Dark mode" });
  await call(updateChangelogEntry, as(), { number: entry.number, tags: ["improved"] });
  await languageTranslationsDone();
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  expect(model.requests).toHaveLength(2);
});

test("an entry is marked while its translations are queued, cleared once they are; the retry job never translates versions nobody confirmed", async () => {
  await languages({ languages: [{ code: "de", newPages: "manual" }] });
  const { entry } = await draft();
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  expect((await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).translationsQueueFailedAt).toBeNull();
  // Published while German was Manual, then German turned Automatic: nothing queues the entry (nobody confirmed it).
  await languages({ languages: [{ code: "de", newPages: "automatic" }] });
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  // A gap from before entries joined a language's bulk translating: left as it is too.
  model.reply(reply("de"));
  await call(retranslateLanguage, as(), { code: "de" });
  await languageTranslationsDone();
  await prisma.changelogTranslation.deleteMany({ where: { entryId: entry.id } });
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  expect(await prisma.changelogTranslation.count({ where: { entryId: entry.id } })).toBe(0);
});

test("languages.get counts a language's published entries with a version, and those waiting and why", async () => {
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  expect((await call(getLanguages, as(), {})).languages[0]!.entries).toEqual({ translated: 1, waiting: 0, why: null });
  await prisma.changelogTranslation.updateMany({ where: { entryId: entry.id }, data: { error: "Out of credits" } });
  expect((await call(getLanguages, as(), {})).languages[0]!.entries).toEqual({ translated: 1, waiting: 1, why: "Out of credits" });
});

test("a published entry's text changed (one section, or all of it as Markdown) brings its German up to date, only the changed paragraph asked", async () => {
  await languages({ languages: [{ code: "de" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, markdown: "Switch themes from your profile menu.\n\nExports finish in seconds." });
  const entryId = await idOf(created.number);
  const entry = () => prisma.changelogEntry.findUniqueOrThrow({ where: { id: entryId } });
  /** Scripts, before the edit (an unscripted request fails), the answer for the segment holding `text` once the entry's text is `body`. */
  const answer = (body: string, text: string) => {
    const { segments } = segmentsOf(translationSource({ title: TITLE, body, content: null }).doc);
    const segment = segments.find((one) => one.text === text)!;
    model.reply(JSON.stringify({ segments: { [segment.id]: `[de] ${text}` } }));
  };
  const { segments } = segmentsOf(translationSource(await entry()).doc);
  model.reply(JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[de] ${text}`])) }));
  await call(publishChangelogEntry, as(), { number: created.number });
  await languageTranslationsDone();
  expect((await translation()).body).toContain("[de] Exports finish in seconds.");

  // One section (the text before any heading), its second paragraph changed.
  model.requests.length = 0;
  answer("Switch themes from your profile menu.\n\nExports finish in two seconds.", "Exports finish in two seconds.");
  await call(editChangelogSection, as(), { number: created.number, section: 0, markdown: "Switch themes from your profile menu.\n\nExports finish in two seconds." });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.user).toContain("Exports finish in two seconds.");
  expect(model.requests[0]!.user).not.toContain("Switch themes from your profile menu.");
  expect((await translation()).body).toContain("[de] Exports finish in two seconds.");
  expect((await translation()).body).toContain("[de] Switch themes from your profile menu.");

  // All of it as Markdown, its first paragraph changed.
  model.requests.length = 0;
  answer("Switch themes from the profile menu.\n\nExports finish in two seconds.", "Switch themes from the profile menu.");
  await call(updateChangelogEntry, as(), { number: created.number, markdown: "Switch themes from the profile menu.\n\nExports finish in two seconds." });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.user).toContain("Switch themes from the profile menu.");
  expect(model.requests[0]!.user).not.toContain("Exports finish in two seconds.");
  expect((await translation()).body).toContain("[de] Switch themes from the profile menu.");
  expect((await translation()).sourceHash).toBe(translationSource(await entry()).hash);
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

test("an email in a subscriber's language marks its translated title and text with that language", async () => {
  await languages({ languages: [{ code: "de", live: true }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const german = `e2e-de-${project.slug}@example.com`;
  await subscriber(german, "de");
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await languageTranslationsDone();
  await vi.waitFor(() => expect(mailbox.emails.filter((m) => m.to.includes(german))).toHaveLength(1));
  const sent = mailbox.emails.find((m) => m.to.includes(german))!.html;
  // Its visible body (the inbox's preview line before it is hidden: display:none, never read out).
  const body = sent.slice(sent.indexOf("<!--body-->"));
  // The title and the text are inside what carries lang="de"; the email's own words before it aren't.
  const at = body.indexOf('lang="de"');
  expect(at).toBeGreaterThan(-1);
  expect(body.slice(at)).toContain("[de] Dark mode");
  expect(body.slice(at)).toContain("[de] Switch themes from your profile menu.");
  expect(body.slice(0, at)).not.toContain("[de]");
});

test("an entry is marked before its translations are queued: one still queuing is left alone (on the database's clock, in any time zone), one left past the grace period is taken", async () => {
  // The database's sessions in New York's time zone, hours behind UTC (a self-hoster's Postgres, say).
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'America/New_York'`);
  await prisma.$disconnect();
  onTestFinished(async () => {
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
    await prisma.$disconnect();
  });
  expect((await prisma.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`)[0]!.zone).toBe("America/New_York");
  await languages({ languages: [{ code: "de" }] });
  const { entry } = await draft();
  // Its queuing held partway (a slow read, or a restart before it's done).
  let release = (_: null) => {};
  const reading = vi.spyOn(prisma.changelogEntry, "findFirst").mockReturnValueOnce(new Promise((resolve) => (release = resolve)) as never);
  const publishing = call(publishChangelogEntry, as(), { number: entry.number });
  const mark = async () => (await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id } })).translationsQueueFailedAt;
  // Marked before anything's queued.
  await vi.waitFor(async () => expect(await mark()).not.toBeNull());
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  // Its queuing never finishes (released with nothing read, it ends without clearing a mark moved meanwhile); past the minute, the retry job takes it.
  await prisma.$executeRaw`UPDATE changelog_entry SET "translationsQueueFailedAt" = "translationsQueueFailedAt" - interval '2 minutes' WHERE id = ${entry.id}`;
  reading.mockRestore();
  model.reply(reply("de"));
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[de] Dark mode" });
  // Cleared in New York's time zone too: the next run takes nothing (and pays for nothing).
  expect(await mark()).toBeNull();
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  release(null);
  await publishing;
});

test("the product switch translates again only the entry versions there are: a language that was Manual gets none started, nothing asked", async () => {
  await languages({ languages: [{ code: "de", newPages: "manual" }] });
  const { entry } = await draft();
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  // German made Automatic (that starts nothing), then "Our product is available in German" switched on.
  await languages({ languages: [{ code: "de", newPages: "automatic" }] });
  await languages({ languages: [{ code: "de", productAvailable: true }] });
  expect(await prisma.changelogTranslation.count({ where: { entryId: entry.id } })).toBe(0);
  expect(model.requests).toHaveLength(0);
});

test("Try again tries again the versions that failed, and starts none: a published entry with no version in the language gets none", async () => {
  await languages({ languages: [{ code: "de", newPages: "manual" }] });
  // Two entries published while German is Manual: neither has a German version.
  const first = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const second = await call(createChangelogEntry, as(), { title: "Faster exports", body: "Exports finish in seconds." });
  await call(publishChangelogEntry, as(), { number: first.number });
  await call(publishChangelogEntry, as(), { number: second.number });
  await languageTranslationsDone();
  // German made Automatic (that starts nothing); the first entry's German then fails (its version waits, with why).
  await languages({ languages: [{ code: "de", newPages: "automatic" }] });
  const failed = await idOf(first.number);
  await prisma.changelogTranslation.create({ data: { entryId: failed, projectId: project.id, language: "de", error: "Out of credits", tries: 1 } });
  // Try again: the one that failed is translated; the other entry gets no version.
  model.reply(reply("de"));
  expect(await call(retranslateLanguage, as(), { code: "de", waiting: true })).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await prisma.changelogTranslation.count({ where: { entryId: await idOf(second.number) } })).toBe(0);
  expect(await translation()).toMatchObject({ title: "[de] Dark mode", error: null });
  // Nothing left waiting, so nothing waiting without a reason.
  expect((await call(getLanguages, as(), {})).languages[0]!.entries).toEqual({ translated: 1, waiting: 0, why: null });
  expect(model.requests).toHaveLength(1);
});

test("a subscriber whose saved language the portal no longer serves gets the entry email in the default language, its Unsubscribe unprefixed", async () => {
  await languages({ languages: [{ code: "de", live: true, newPages: "manual" }] });
  const german = `e2e-offline-${project.slug}@example.com`;
  await subscriber(german, "de");
  // German taken offline after they subscribed in it.
  await languages({ languages: [{ code: "de", live: false, newPages: "manual" }] });
  const created = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  await call(publishChangelogEntry, as(), { number: created.number, emailSubscribers: true });
  await vi.waitFor(() => expect(entryEmails(german)).toHaveLength(1));
  const [email] = entryEmails(german);
  expect(email!.html).toMatch(/<html[^>]* lang="en"/);
  expect(email!.text).toContain("New ·");
  expect(email!.text).toContain("Unsubscribe");
  expect(email!.html).toMatch(/\/changelog\/subscription\?token=/);
  expect(email!.html).not.toMatch(/\/de\/changelog/);
});
