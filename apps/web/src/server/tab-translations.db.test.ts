import { prisma } from "@tuti/db";
import { labelIn, languageTranslationsDone } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createTab, updateTab } from "./operations/docs";
import { getTabTranslations, updateTabTranslation } from "./operations/label-translations";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** A tab's settings → Translations (docs/plan.md, Languages, L13): its name in each language. */

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
afterEach(async () => {
  await languageTranslationsDone();
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const labelsReply = (segments: Record<string, string>) => JSON.stringify({ segments });
const guides = () => prisma.docsTab.findFirstOrThrow({ where: { projectId: project.id, slug: "guides" } });
const translations = async () => (await call(getTabTranslations, as(), { slug: "guides" })).translations;

/** German kept up to date and French written by the team, and the Guides tab (translated into German). */
async function setUp() {
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  model.reply(labelsReply({ "0.n": "Anleitungen" }));
  await call(createTab, as(), { name: "Guides" });
  await languageTranslationsDone();
}

test("each language: the name readers see and whether it's kept up to date; renamed, none until it's made again", async () => {
  await setUp();
  expect(await translations()).toEqual([
    { language: "de", name: "Anleitungen", keepUpToDate: true },
    { language: "fr", name: null, keepUpToDate: false },
  ]);
  let meanwhile: unknown;
  model.reply(labelsReply({ "0.n": "Handbücher" }), async () => {
    meanwhile = (await call(getTabTranslations, as(), { slug: "manuals" })).translations[0];
  });
  await call(updateTab, as(), { slug: "guides", name: "Manuals" });
  await languageTranslationsDone();
  expect(meanwhile).toEqual({ language: "de", name: null, keepUpToDate: true });
  expect((await call(getTabTranslations, as(), { slug: "manuals" })).translations[0]).toEqual({ language: "de", name: "Handbücher", keepUpToDate: true });
});

test("the team's own name: readers see it, never translated over; kept up to date again, it's made anew", async () => {
  await setUp();
  expect(await call(updateTabTranslation, as(), { slug: "guides", language: "de", keepUpToDate: false, name: "Leitfäden" })).toEqual({ language: "de", name: "Leitfäden", keepUpToDate: false });
  expect(labelIn(await guides(), "de")).toEqual({ name: "Leitfäden", description: "" });
  // A tab has no description: none is stored with it.
  expect(((await guides()).translations as Record<string, object>).de).not.toHaveProperty("description");
  await call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: false, name: "Guides pratiques" });
  model.reply(labelsReply({ "0.n": "Tutoriels" }));
  expect(await call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: true })).toEqual({ language: "fr", name: null, keepUpToDate: true });
  await languageTranslationsDone();
  expect(labelIn(await guides(), "fr")).toEqual({ name: "Tutoriels", description: "" });
  expect(labelIn(await guides(), "de")).toEqual({ name: "Leitfäden", description: "" });
});

test("refused: no name, a language the project doesn't have, a tab that isn't there, kept up to date with AI off", async () => {
  await setUp();
  await expect(call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: false })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateTabTranslation, as(), { slug: "guides", language: "es", keepUpToDate: false, name: "Guías" })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateTabTranslation, as(), { slug: "nowhere", language: "fr", keepUpToDate: false, name: "Nulle part" })).rejects.toMatchObject({ status: 404 });
  vi.stubEnv("OPENAI_API_KEY", "");
  await expect(call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: true })).rejects.toMatchObject({ status: 409, code: "ai_off" });
  expect((await guides()).translations).not.toHaveProperty("fr");
});

test("a name longer than a tab's own may be (40 characters) is refused, and nothing is saved", async () => {
  await setUp();
  await expect(call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: false, name: "x".repeat(41) })).rejects.toMatchObject({ status: 400 });
  expect((await guides()).translations).not.toHaveProperty("fr");
  // 40 is fine.
  await call(updateTabTranslation, as(), { slug: "guides", language: "fr", keepUpToDate: false, name: "x".repeat(40) });
  expect(labelIn(await guides(), "fr")).toEqual({ name: "x".repeat(40), description: "" });
});

