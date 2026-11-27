import { prisma } from "@tuti/db";
import { labelIn, languageTranslationsDone } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createCollection, updateCollection } from "./operations/docs";
import { getCollectionTranslations, updateCollectionTranslation } from "./operations/label-translations";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** A collection's settings → Translations (docs/plan.md, Languages, L13): its name and description in each language. */

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
const billing = () => prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } });
const translations = async () => (await call(getCollectionTranslations, as(), { slug: "billing" })).translations;

/** German kept up to date and French written by the team, and Billing (translated into German). */
async function setUp() {
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen und Rechnungen." }));
  await call(createCollection, as(), { name: "Billing", description: "Paying and invoices." });
  await languageTranslationsDone();
}

test("each language: the translation readers see and whether it's kept up to date; none yet in a language the team writes", async () => {
  await setUp();
  expect(await translations()).toEqual([
    { language: "de", name: "Abrechnung", description: "Bezahlen und Rechnungen.", keepUpToDate: true },
    { language: "fr", name: null, description: null, keepUpToDate: false },
  ]);
  // Renamed: German's translation is of the old name, so none is shown until it's made again.
  let meanwhile: unknown;
  model.reply(labelsReply({ "0.n": "Zahlungen", "0.d": "Bezahlen und Rechnungen." }), async () => {
    meanwhile = (await call(getCollectionTranslations, as(), { slug: "payments" })).translations[0];
  });
  await call(updateCollection, as(), { slug: "billing", name: "Payments" });
  await languageTranslationsDone();
  expect(meanwhile).toMatchObject({ name: null, keepUpToDate: true });
  expect((await call(getCollectionTranslations, as(), { slug: "payments" })).translations[0]).toMatchObject({ name: "Zahlungen", keepUpToDate: true });
});

test("the team's own name and description: readers see them, and they're never translated over", async () => {
  await setUp();
  expect(await call(updateCollectionTranslation, as(), { slug: "billing", language: "de", keepUpToDate: false, name: "Bezahlung", description: "Alles zum Bezahlen." })).toEqual({
    language: "de",
    name: "Bezahlung",
    description: "Alles zum Bezahlen.",
    keepUpToDate: false,
  });
  expect(labelIn(await billing(), "de")).toEqual({ name: "Bezahlung", description: "Alles zum Bezahlen." });
  // Its description changed: German is the team's, so nothing is asked of the model, and it stays.
  await call(updateCollection, as(), { slug: "billing", description: "Paying, invoices and refunds." });
  await languageTranslationsDone();
  expect(labelIn(await billing(), "de")).toEqual({ name: "Bezahlung", description: "Alles zum Bezahlen." });
  // Added in French, the language the team writes.
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false, name: "Facturation" });
  expect(labelIn(await billing(), "fr")).toEqual({ name: "Facturation", description: "" });
});

test("kept up to date again: translated anew from its name and description, readers seeing the default language's meanwhile", async () => {
  await setUp();
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false, name: "Facturation" });
  let meanwhile: unknown[] = [];
  model.reply(labelsReply({ "0.n": "Paiements", "0.d": "Payer et factures." }), async () => {
    meanwhile = [labelIn(await billing(), "fr"), (await translations())[1]];
  });
  expect(await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: true })).toMatchObject({ name: null, keepUpToDate: true });
  await languageTranslationsDone();
  expect(meanwhile).toEqual([null, { language: "fr", name: null, description: null, keepUpToDate: true }]);
  expect((await translations())[1]).toEqual({ language: "fr", name: "Paiements", description: "Payer et factures.", keepUpToDate: true });
  // Already kept up to date and current: nothing to make again.
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "de", keepUpToDate: true });
  await languageTranslationsDone();
  expect(labelIn(await billing(), "de")).toEqual({ name: "Abrechnung", description: "Bezahlen und Rechnungen." });
});

test("refused: a language the project doesn't have, the team's own with no name, a collection that isn't there", async () => {
  await setUp();
  await expect(call(updateCollectionTranslation, as(), { slug: "billing", language: "es", keepUpToDate: false, name: "Facturación" })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false })).rejects.toMatchObject({ status: 400 });
  await expect(call(updateCollectionTranslation, as(), { slug: "nowhere", language: "fr", keepUpToDate: false, name: "Nulle part" })).rejects.toMatchObject({ status: 404 });
  expect(labelIn(await billing(), "fr")).toBeNull();
});

test("the team's own name alone: the description written there before stays", async () => {
  await setUp();
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false, name: "Facturation", description: "Payer et factures." });
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false, name: "Paiements" });
  expect(labelIn(await billing(), "fr")).toEqual({ name: "Paiements", description: "Payer et factures." });
});

test("kept up to date is refused with AI off (it would never be made) and on a sample collection (never translated); nothing is saved", async () => {
  await setUp();
  vi.stubEnv("OPENAI_API_KEY", "");
  await expect(call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: true })).rejects.toMatchObject({ status: 409, code: "ai_off" });
  expect((await billing()).translations).not.toHaveProperty("fr");
  vi.stubEnv("OPENAI_API_KEY", model.env.OPENAI_API_KEY!);
  await prisma.collection.updateMany({ where: { projectId: project.id, slug: "billing" }, data: { sample: true } });
  await expect(call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: true })).rejects.toMatchObject({ status: 409, code: "sample" });
  expect((await billing()).translations).not.toHaveProperty("fr");
  // The team's own is fine there.
  await call(updateCollectionTranslation, as(), { slug: "billing", language: "fr", keepUpToDate: false, name: "Facturation" });
  expect(labelIn(await billing(), "fr")).toEqual({ name: "Facturation", description: "" });
});

