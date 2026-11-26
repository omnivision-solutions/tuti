import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { ANNOUNCEMENT_WAITS_MS, handlers, languageTranslationsDone, PRODUCT_SETTING_CHANGED, translationSource } from "@tuti/jobs";
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

test("the product setting changing retranslates entries kept up to date and marks the team's own behind; Retranslate and the retry job take entries too", async () => {
  await languages({ languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  const { entry } = await draft();
  model.reply(reply("de"));
  await call(publishChangelogEntry, as(), { number: entry.number });
  await languageTranslationsDone();
  await prisma.changelogTranslation.create({ data: { entryId: entry.id, projectId: project.id, language: "fr", automatic: false, title: "Mode sombre", publishedAt: new Date() } });

  model.reply(reply("on"));
  await languages({ languages: [{ code: "de", productAvailable: true }, { code: "fr", productAvailable: true }] });
  expect(await translation()).toMatchObject({ title: "[on] Dark mode", productAvailable: true });
  expect(Object.values((await translation("fr")).behind as Record<string, string>)).toContain(PRODUCT_SETTING_CHANGED);
  expect(model.requests.at(-1)!.system).toContain("The product is available in German");

  // Retranslate: the entry too, nothing reused.
  model.reply(reply("again"));
  expect(await call(retranslateLanguage, as(), { code: "de" })).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect((await translation()).title).toBe("[again] Dark mode");

  // A version that couldn't be translated, its wait over: the retry job translates it.
  await prisma.changelogTranslation.updateMany({ where: { entryId: entry.id, language: "de" }, data: { error: "Out of credits", retryAt: new Date(Date.now() - 1000), retranslate: { increment: 1 } } });
  model.reply(reply("retried"));
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  await languageTranslationsDone();
  expect(await translation()).toMatchObject({ title: "[retried] Dark mode", error: null, retryAt: null });
});
