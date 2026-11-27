import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { languageTranslationsDone, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { keepChangelogVersionUpToDate, saveChangelogVersion } from "./changelog";
import { entryLanguages } from "./changelog-languages";
import { createChangelogEntry, publishChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { getChangelogTranslation, saveChangelogTranslation } from "./operations/changelog-translations";
import { OperationError } from "./operations/define";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** An entry's versions in other languages from its editor's language pill (docs/plan.md L16): changelog.getTranslation and .saveTranslation. */

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
const TITLE = "Dark mode";
const BODY = "Switch themes from your profile menu.";
const paragraph = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** A reply translating every segment of the entry (`title`, `body`) with `[tag] ` before each one's text. */
function reply(tag: string, title = TITLE, body = BODY) {
  const { segments } = segmentsOf(translationSource({ title, body, content: null }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
}

/** A published entry, with German `newPages` (automatic ones translated as it's published). */
async function published(newPages: "automatic" | "manual") {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages }] });
  const { number } = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  if (newPages === "automatic") {
    model.reply(reply("de"));
  }
  await call(publishChangelogEntry, as(), { number });
  await languageTranslationsDone();
  return number;
}

const refused = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
};

test("a Manual language's version is written by the team: readers get it at once, and a save from an older read is refused", async () => {
  const number = await published("manual");
  const empty = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect(empty).toMatchObject({ keepUpToDate: false, title: "", content: null, publishedAt: null, behind: false });
  const saved = await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: empty.version });
  expect(saved).toMatchObject({ keepUpToDate: false, title: "Dunkler Modus", behind: false });
  expect(saved.publishedAt).not.toBeNull();
  expect(await prisma.changelogTranslation.findFirstOrThrow({ where: { projectId: project.id, language: "de" } })).toMatchObject({ body: "Wechsle das Design im Profilmenü.", automatic: false });
  // The first read's version is out of date now.
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Alt", content: paragraph("Alt."), version: empty.version }))).code).toBe("changed");
  // The entry changed since: it's behind, and stays the team's.
  await call(updateChangelogEntry, as(), { number, title: "Dark mode is here" });
  await languageTranslationsDone();
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ title: "Dunkler Modus", behind: true });
});

test("editing an automatic version turns Keep up to date off, so the entry's next change never replaces it; turned back on, it's translated anew", async () => {
  const number = await published("automatic");
  const translated = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect(translated).toMatchObject({ keepUpToDate: true, title: "[de] Dark mode", behind: false });
  await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: translated.version });
  // The entry changes: nothing asked, the team's title stays.
  await call(updateChangelogEntry, as(), { number, body: "Switch themes from the menu." });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(1);
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ keepUpToDate: false, title: "Dunkler Modus", behind: true });
  // Keep up to date back on: translated from the entry as it is, nothing reused.
  model.reply(reply("de", TITLE, "Switch themes from the menu."));
  const before = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect(await call(saveChangelogTranslation, as(), { number, language: "de", keepUpToDate: true, version: before.version })).toMatchObject({ keepUpToDate: true });
  await languageTranslationsDone();
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ keepUpToDate: true, title: "[de] Dark mode", behind: false });
  expect(model.requests.at(-1)!.user).toContain("Dark mode");
});

test("a draft's versions wait for its publish, a first version needs its text, and text and Keep up to date don't go together", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  const { number } = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const read = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Text."), version: read.version }))).code).toBe("not_published");
  await call(publishChangelogEntry, as(), { number });
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: read.version }))).message).toBe("Write its text first");
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", content: paragraph("Text."), keepUpToDate: false, version: read.version }))).status).toBe(400);
  // Not one of the project's languages.
  expect((await refused(call(getChangelogTranslation, as(), { number, language: "fr" }))).status).toBe(404);
});

test("the product setting changing marks the team's version behind, and saving it clears that", async () => {
  const number = await published("manual");
  const empty = await call(getChangelogTranslation, as(), { number, language: "de" });
  const saved = await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: empty.version });
  // "Our product is available in German" turned on: the team's version is marked behind (markProductSettingBehind).
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual", productAvailable: true }] });
  await languageTranslationsDone();
  const marked = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect(marked).toMatchObject({ behind: true, keepUpToDate: false });
  // A save from a read before the mark is refused: it would clear a mark its editor never saw.
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: saved.version }))).code).toBe("changed");
  expect(await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: marked.version })).toMatchObject({ behind: false });
});

test("a save made beside the entry's older text is refused, so it never reads as up to date with text its editor never saw", async () => {
  const number = await published("manual");
  const read = await call(getChangelogTranslation, as(), { number, language: "de" });
  // A teammate changes the entry while the German is written.
  await call(updateChangelogEntry, as(), { number, body: "Switch themes from the menu." });
  const error = await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: read.version }));
  expect(error.code).toBe("changed");
});

test("an Automatic language added after an entry was published has no version: Keep up to date reads off, and turning it on translates it", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "fr", newPages: "manual" }] });
  const { number } = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  await call(publishChangelogEntry, as(), { number });
  await call(updateLanguages, as(), { languages: [{ code: "fr", newPages: "manual" }, { code: "de" }] });
  await languageTranslationsDone();
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ keepUpToDate: false, publishedAt: null });
  model.reply(reply("de"));
  const none = await call(getChangelogTranslation, as(), { number, language: "de" });
  await call(saveChangelogTranslation, as(), { number, language: "de", keepUpToDate: true, version: none.version });
  await languageTranslationsDone();
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ keepUpToDate: true, title: "[de] Dark mode" });
});

test("an entry's languages in its editor: none for a draft or a sample entry, each other language's state for a published one", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  const { number } = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  const read = () => prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } });
  expect(await entryLanguages(project.id, project.slug, await read())).toBeNull();
  await call(publishChangelogEntry, as(), { number });
  expect(await entryLanguages(project.id, project.slug, await read())).toEqual([
    { code: "en", name: "English", state: "default", href: `/app/${project.slug}/changelog/${number}` },
    { code: "de", name: "Deutsch", state: "unwritten", href: `/app/${project.slug}/changelog/${number}?language=de` },
  ]);
  await prisma.changelogEntry.update({ where: { id: (await read()).id }, data: { sample: true } });
  expect(await entryLanguages(project.id, project.slug, await read())).toBeNull();
});

test("turning Keep up to date off doesn't refuse the save that follows: what the edit was made from didn't change", async () => {
  const number = await published("automatic");
  const read = await call(getChangelogTranslation, as(), { number, language: "de" });
  await call(saveChangelogTranslation, as(), { number, language: "de", keepUpToDate: false, version: read.version });
  expect(await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: read.version })).toMatchObject({ title: "Dunkler Modus", keepUpToDate: false });
});

test("Keep up to date turned on over the team's text: translating until it's answered, waiting if it fails, and refused from a read older than their text", async () => {
  const number = await published("automatic");
  const translated = await call(getChangelogTranslation, as(), { number, language: "de" });
  const saved = await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: translated.version });
  // From the read before the team's text: refused, so it's never replaced unconfirmed.
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", keepUpToDate: true, version: translated.version }))).code).toBe("changed");
  const state = async () => (await entryLanguages(project.id, project.slug, await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })))![1]!.state;
  expect(await state()).toBe("written");
  // On, its translation held: still made from the entry's text, but not up to date until it's answered.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(JSON.stringify({ segments: {} }), () => held);
  await call(saveChangelogTranslation, as(), { number, language: "de", keepUpToDate: true, version: saved.version });
  expect(await state()).toBe("translating");
  // The answer leaves its segments untranslated, and so does the one asked to fix them: it fails, and waits.
  model.reply(JSON.stringify({ segments: {} }));
  release();
  await languageTranslationsDone();
  expect(await state()).toBe("waiting");
});

test("Keep up to date from the editor after the English changed: the page's new read works; an old one is refused with a short line, not stuck", async () => {
  const number = await published("manual");
  const empty = await call(getChangelogTranslation, as(), { number, language: "de" });
  await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: empty.version });
  const opened = await call(getChangelogTranslation, as(), { number, language: "de" });
  // The English edited (by a teammate, say) while the version stays open.
  await call(updateChangelogEntry, as(), { number, body: "Switch themes from the menu." });
  actAs(owner);
  expect(await keepChangelogVersionUpToDate(project.slug, number, "de", true, opened.version)).toMatchObject({ changed: true });
  // The page's next read (the editor reads it again): on, and translated.
  const now = await call(getChangelogTranslation, as(), { number, language: "de" });
  model.reply(reply("de", TITLE, "Switch themes from the menu."));
  expect(await keepChangelogVersionUpToDate(project.slug, number, "de", true, now.version)).toEqual({ version: expect.any(String) });
  await languageTranslationsDone();
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ keepUpToDate: true, title: "[de] Dark mode", behind: false });
});

test("Keep up to date turned on where there's no version yet, then Save before its translation lands: the save goes from the toggle's token and wins", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "fr", newPages: "manual" }] });
  const { number } = await call(createChangelogEntry, as(), { title: TITLE, body: BODY });
  await call(publishChangelogEntry, as(), { number });
  await call(updateLanguages, as(), { languages: [{ code: "fr", newPages: "manual" }, { code: "de" }] });
  await languageTranslationsDone();
  const none = await call(getChangelogTranslation, as(), { number, language: "de" });
  expect(none.publishedAt).toBeNull();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  model.reply(reply("de"), () => held);
  actAs(owner);
  const toggled = await keepChangelogVersionUpToDate(project.slug, number, "de", true, none.version);
  expect(toggled.version).toBeDefined();
  expect(toggled.version).not.toBe(none.version);
  // Save, its translation still on its way: the toggle's token is current.
  const form = new FormData();
  form.set("title", "Dunkler Modus");
  form.set("content", JSON.stringify(paragraph("Wechsle das Design im Profilmenü.")));
  form.set("version", toggled.version!);
  expect(await saveChangelogVersion(project.slug, number, "de", {}, form)).toMatchObject({ version: expect.any(String) });
  release();
  await languageTranslationsDone();
  // Saving turned Keep up to date off: the translation finishing writes nothing over it.
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ title: "Dunkler Modus", keepUpToDate: false });
});

test("a save's token is against the entry's text it was checked under, never a read after it (an edit landing in between)", async () => {
  const number = await published("manual");
  const empty = await call(getChangelogTranslation, as(), { number, language: "de" });
  // Any read of the entry after the save's own (under its lock) sees the English edited.
  const reading = vi.spyOn(prisma.changelogEntry, "findUniqueOrThrow").mockResolvedValue({ title: "Dark mode is here", body: BODY, content: null } as never);
  let saved;
  try {
    saved = await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: empty.version });
  } finally {
    reading.mockRestore();
  }
  // The token is the one a read now gives: the English it was saved beside.
  expect(saved.version).toBe((await call(getChangelogTranslation, as(), { number, language: "de" })).version);
});

test("a save made while the product setting marks the version behind waits for it and is refused, never writing over the mark", async () => {
  const number = await published("manual");
  const empty = await call(getChangelogTranslation, as(), { number, language: "de" });
  await call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", content: paragraph("Wechsle das Design im Profilmenü."), version: empty.version });
  const read = await call(getChangelogTranslation, as(), { number, language: "de" });
  const entryId = (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  // The setting's change holds the version's row, marked behind, not committed yet (as updateLanguages does).
  let locked = () => {};
  const marked = new Promise<void>((resolve) => (locked = resolve));
  let commit = () => {};
  const held = new Promise<void>((resolve) => (commit = resolve));
  const marking = prisma.$transaction(
    async (tx) => {
      await tx.changelogTranslation.updateMany({ where: { entryId, language: "de" }, data: { behind: { "\u001f0": "The product setting changed" } } });
      locked();
      await held;
    },
    { timeout: 30_000 },
  );
  await marked;
  // The save, from the read before the mark, reaches the row's lock and waits; then the mark commits.
  const saving = call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus!", version: read.version }).then(
    () => null,
    (error: unknown) => error,
  );
  // Waiting on the version's row lock (not on a timer): only then does the mark commit. Released whatever happens, so a
  // failed wait never leaves the transaction holding the row.
  try {
    await expect
      .poll(
        async () =>
          (
            await prisma.$queryRaw<[{ n: number }]>`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%changelog_translation%FOR UPDATE%'`
          )[0].n > 0,
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    commit();
    await marking.catch(() => {});
  }
  expect(((await saving) as OperationError).code).toBe("changed");
  expect(await call(getChangelogTranslation, as(), { number, language: "de" })).toMatchObject({ title: "Dunkler Modus", behind: true });
});

test("a version's token follows its text as shown: a body changing where it has no content is a change", async () => {
  const number = await published("manual");
  const entryId = (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })).id;
  await prisma.changelogTranslation.create({ data: { entryId, projectId: project.id, language: "de", automatic: false, title: "Dunkler Modus", body: "Erste Fassung.", publishedAt: new Date() } });
  const read = await call(getChangelogTranslation, as(), { number, language: "de" });
  await prisma.changelogTranslation.updateMany({ where: { entryId, language: "de" }, data: { body: "Zweite Fassung." } });
  expect((await refused(call(saveChangelogTranslation, as(), { number, language: "de", title: "Dunkler Modus", version: read.version }))).code).toBe("changed");
});
