import { prisma } from "@tuti/db";
import { forgetLabels, handlers, labelIn, labelSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createCollection, createTab, updateCollection, updateTab } from "./operations/docs";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Labels' translations (docs/plan.md, Languages, L13): collection and tab names in the project's other languages. */

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

/** The model's answer to a labels request: each label's segments (`<i>.n` its name, `<i>.d` its description), in the order sent. */
const labelsReply = (segments: Record<string, string>) => JSON.stringify({ segments });

const german = (newPages: "automatic" | "manual" = "automatic") => call(updateLanguages, as(), { languages: [{ code: "de", newPages }] });
const collection = (slug: string) => prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug } });
const tab = (slug: string) => prisma.docsTab.findFirstOrThrow({ where: { projectId: project.id, slug } });

test("a new collection and tab are translated into a language kept up to date; a renamed one again, never shown with its old name meanwhile", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen und Rechnungen." }));
  await call(createCollection, as(), { name: "Billing", description: "Paying and invoices." });
  expect(labelIn(await collection("billing"), "de")).toEqual({ name: "Abrechnung", description: "Bezahlen und Rechnungen." });
  expect(labelIn(await collection("billing"), "fr")).toBeNull();
  model.reply(labelsReply({ "0.n": "Anleitungen" }));
  await call(createTab, as(), { name: "Guides" });
  expect(labelIn(await tab("guides"), "de")).toEqual({ name: "Anleitungen", description: "" });

  // Renamed while the provider is down: readers see the default language's name, never the old translation.
  model.fail(500);
  model.fail(500);
  await call(updateCollection, as(), { slug: "billing", name: "Payments" });
  expect(labelIn(await collection("payments"), "de")).toBeNull();
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 1, labelsRetryAt: expect.any(Date) });
  // The retry job waits for its time, then translates it.
  expect(await handlers.retryArticleTranslations({}, log)).not.toHaveProperty("labels");
  await prisma.projectLanguage.updateMany({ where: { projectId: project.id }, data: { labelsRetryAt: new Date(Date.now() - 1000) } });
  model.reply(labelsReply({ "0.n": "Zahlungen", "0.d": "Bezahlen und Rechnungen." }));
  expect(await handlers.retryArticleTranslations({}, log)).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("payments"), "de")).toEqual({ name: "Zahlungen", description: "Bezahlen und Rechnungen." });
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 0, labelsRetryAt: null });
  // Only the renamed collection was sent, its name and description; the tab's translation was still current.
  expect(model.requests.at(-1)!.messages.at(-1)!.content).not.toContain("Guides");
});

test("adding a language translates the labels there are; a label the team wrote is never replaced", async () => {
  // No other language yet: nothing to translate them into.
  await call(createCollection, as(), { name: "Billing", description: "" });
  await call(createCollection, as(), { name: "Setup", description: "" });
  // The team's own German for Setup.
  const setup = await collection("setup");
  await prisma.collection.update({ where: { id: setup.id }, data: { translations: { de: { name: "Einrichten", description: "", auto: false, source: labelSource("Setup") } } } });
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await german();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung");
  // Renamed, the team's stays theirs (and is shown: they decide when to change it).
  await call(updateCollection, as(), { slug: "setup", name: "Getting set up" });
  expect(labelIn(await collection("getting-set-up"), "de")?.name).toBe("Einrichten");
});

test("a language the team writes gets no translations of new labels; a sample collection is never translated", async () => {
  await german("manual");
  await call(createCollection, as(), { name: "Billing", description: "" });
  await prisma.collection.create({ data: { projectId: project.id, slug: "sample-basics", name: "Basics", sample: true } });
  expect(await handlers.retryArticleTranslations({}, log)).not.toHaveProperty("labels");
  expect(labelIn(await collection("billing"), "de")).toBeNull();
  expect(model.requests).toHaveLength(0);
});

test("a collection written another way (an import, Autopilot) is found and translated by the retry job", async () => {
  await german();
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported", description: "From elsewhere." } });
  model.reply(labelsReply({ "0.n": "Importiert", "0.d": "Von woanders." }));
  expect(await handlers.retryArticleTranslations({}, log)).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("imported"), "de")).toEqual({ name: "Importiert", description: "Von woanders." });
});

test("Retranslate makes the labels kept up to date again; one failing its checks waits, the others are written", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await call(createCollection, as(), { name: "Billing", description: "" });
  model.reply(labelsReply({ "0.n": "Einrichtung" }));
  await call(createCollection, as(), { name: "Setup", description: "" });
  // Billing comes back translated; Setup comes back empty twice (its check fails, then its retry's).
  model.reply(labelsReply({ "0.n": "Zahlung", "1.n": "" }));
  model.reply(labelsReply({ "1.n": "" }));
  await call(retranslateLanguage, as(), { code: "de" });
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Zahlung");
  expect(labelIn(await collection("setup"), "de")).toBeNull();
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 1, labelsRetryAt: expect.any(Date) });
});

test("the product setting changing between a label's translating and its write: nothing written, the labels made again under the new one", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] }));
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await call(createCollection, as(), { name: "Billing", description: "" });
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
  // Nothing failed: nothing waits.
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 0, labelsRetryAt: null });
});

test("renaming a tab translates it again", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Anleitungen" }));
  await call(createTab, as(), { name: "Guides" });
  model.reply(labelsReply({ "0.n": "Hilfe" }));
  await call(updateTab, as(), { slug: "guides", name: "Help" });
  expect(labelIn(await tab("help"), "de")?.name).toBe("Hilfe");
});

test("Retranslate while a labels job translates: that job writes nothing, the label is made again", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => call(retranslateLanguage, as(), { code: "de" }));
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await call(createCollection, as(), { name: "Billing", description: "" });
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
});

test("a removed language's label translations go with it: added again, its labels are translated anew", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await call(createCollection, as(), { name: "Billing", description: "" });
  await call(updateLanguages, as(), { languages: [] });
  expect((await collection("billing")).translations).toEqual({});
  model.reply(labelsReply({ "0.n": "Zahlungen" }));
  await german();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Zahlungen");
});

test("a language removed and added again while a labels job translates: that job writes nothing, the label is made anew", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), async () => {
    await call(updateLanguages, as(), { languages: [] });
    await call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] });
  });
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await call(createCollection, as(), { name: "Billing", description: "" });
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
});

test("a language being removed as a labels job writes a new label's translation: the write waits for the removal, and writes nothing", async () => {
  await german();
  // A removal held open (not yet committed) as the job writes: its row deleted and its labels forgotten (Billing has none yet).
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let removing!: Promise<void>;
  model.reply(labelsReply({ "0.n": "Abrechnung" }), async () => {
    let deleted!: () => void;
    const started = new Promise<void>((resolve) => (deleted = resolve));
    removing = prisma.$transaction(
      async (tx) => {
        await tx.projectLanguage.deleteMany({ where: { projectId: project.id, code: "de" } });
        await forgetLabels(tx, project.id, ["de"]);
        deleted();
        await gate;
      },
      { timeout: 20_000 },
    );
    await started;
  });
  const creating = call(createCollection, as(), { name: "Billing", description: "" });
  // Let the removal go once the job is waiting on the language's row (or after 5 seconds).
  let waited = false;
  for (let i = 0; i < 100 && !waited; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waited = Number(count) > 0;
    if (!waited) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await Promise.all([removing, creating]);
  expect((await collection("billing")).translations).toEqual({});
});

test("a collection's description changing on its own is translated again at once", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen." }));
  await call(createCollection, as(), { name: "Billing", description: "Paying." });
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen und Rechnungen." }));
  await call(updateCollection, as(), { slug: "billing", description: "Paying and invoices." });
  expect(labelIn(await collection("billing"), "de")).toEqual({ name: "Abrechnung", description: "Bezahlen und Rechnungen." });
});

test("a languages save that removes one language and changes another waits for a label write under way: no deadlock", async () => {
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  model.reply(labelsReply({ "0.n": "Facturation" }));
  await call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr" }] });
  await call(createCollection, as(), { name: "Billing", description: "" });
  const { id } = await collection("billing");
  // A French label write as writeLabel makes it, held open: French's row shared, then (once the save waits) the collection's.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let shared!: () => void;
  const holding = new Promise<void>((resolve) => (shared = resolve));
  const writing = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM project_language WHERE "projectId" = ${project.id} AND code = 'fr' FOR SHARE`;
      shared();
      await gate;
      await tx.$queryRaw`SELECT 1 FROM collection WHERE id = ${id} FOR UPDATE`;
    },
    { timeout: 20_000 },
  );
  await holding;
  // German removed and French's product setting changed (its labels made again: answered below).
  model.otherwise(labelsReply({ "0.n": "Facturation (produit)" }), '"0.n":"Billing"');
  const saving = call(updateLanguages, as(), { languages: [{ code: "fr", productAvailable: true }] });
  for (let i = 0; i < 100; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(count) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await Promise.all([writing, saving]);
  expect(Object.keys((await collection("billing")).translations as object)).toEqual(["fr"]);
});

test("a language's wait is kept whatever the database's time zone (its time is UTC)", async () => {
  await german();
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported" } });
  // Waiting another hour, on a server whose sessions are 14 hours ahead of UTC.
  await prisma.projectLanguage.updateMany({ where: { projectId: project.id }, data: { labelsTries: 1, labelsRetryAt: new Date(Date.now() + 3_600_000) } });
  const [{ name }] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO 'Pacific/Kiritimati'`);
  await prisma.$disconnect();
  try {
    expect(await handlers.retryArticleTranslations({}, log)).not.toHaveProperty("labels");
  } finally {
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" RESET timezone`);
    await prisma.$disconnect();
  }
});
