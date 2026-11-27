import { prisma } from "@tuti/db";
import { forgetLabels, handlers, labelIn, labelSource, languageTranslationsDone, lockProject } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createCollection, createTab, updateCollection, updateTab } from "./operations/docs";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

// Hatchet out of reach, for a test that queues without the inline driver.
vi.mock("@tuti/shared/hatchet", async (original) => ({
  ...(await original<typeof import("@tuti/shared/hatchet")>()),
  getHatchet: () => {
    throw new Error("Hatchet isn't reachable");
  },
}));

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

/** `saving`, then the label translating it queued in the background done. */
async function settled<T>(saving: Promise<T>): Promise<T> {
  const result = await saving;
  await languageTranslationsDone();
  return result;
}
/** The retry job's run, and what it queued done. */
const retry = () => settled(handlers.retryArticleTranslations({}, log));

/** The model's answer to a labels request: each label's segments (`<i>.n` its name, `<i>.d` its description), in the order sent. */
const labelsReply = (segments: Record<string, string>) => JSON.stringify({ segments });

const german = (newPages: "automatic" | "manual" = "automatic") => settled(call(updateLanguages, as(), { languages: [{ code: "de", newPages }] }));
const collection = (slug: string) => prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug } });
const tab = (slug: string) => prisma.docsTab.findFirstOrThrow({ where: { projectId: project.id, slug } });

test("a new collection and tab are translated into a language kept up to date; a renamed one again, never shown with its old name meanwhile", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen und Rechnungen." }));
  await settled(call(createCollection, as(), { name: "Billing", description: "Paying and invoices." }));
  expect(labelIn(await collection("billing"), "de")).toEqual({ name: "Abrechnung", description: "Bezahlen und Rechnungen." });
  expect(labelIn(await collection("billing"), "fr")).toBeNull();
  model.reply(labelsReply({ "0.n": "Anleitungen" }));
  await settled(call(createTab, as(), { name: "Guides" }));
  expect(labelIn(await tab("guides"), "de")).toEqual({ name: "Anleitungen", description: "" });

  // Renamed while the provider is down: readers see the default language's name, never the old translation.
  model.fail(500);
  model.fail(500);
  await settled(call(updateCollection, as(), { slug: "billing", name: "Payments" }));
  expect(labelIn(await collection("payments"), "de")).toBeNull();
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 1, labelsRetryAt: expect.any(Date) });
  // The retry job waits for its time, then translates it.
  expect(await retry()).not.toHaveProperty("labels");
  await prisma.projectLanguage.updateMany({ where: { projectId: project.id }, data: { labelsRetryAt: new Date(Date.now() - 1000) } });
  model.reply(labelsReply({ "0.n": "Zahlungen", "0.d": "Bezahlen und Rechnungen." }));
  expect(await retry()).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("payments"), "de")).toEqual({ name: "Zahlungen", description: "Bezahlen und Rechnungen." });
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 0, labelsRetryAt: null });
  // Only the renamed collection was sent, its name and description; the tab's translation was still current.
  expect(model.requests.at(-1)!.messages.at(-1)!.content).not.toContain("Guides");
});

test("adding a language translates the labels there are; a label the team wrote is never replaced", async () => {
  // No other language yet: nothing to translate them into.
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  await settled(call(createCollection, as(), { name: "Setup", description: "" }));
  // The team's own German for Setup.
  const setup = await collection("setup");
  await prisma.collection.update({ where: { id: setup.id }, data: { translations: { de: { name: "Einrichten", description: "", auto: false, source: labelSource("Setup") } } } });
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await german();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung");
  // Renamed, the team's stays theirs (and is shown: they decide when to change it).
  await settled(call(updateCollection, as(), { slug: "setup", name: "Getting set up" }));
  expect(labelIn(await collection("getting-set-up"), "de")?.name).toBe("Einrichten");
});

test("a language the team writes gets no translations of new labels; a sample collection is never translated", async () => {
  await german("manual");
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  await prisma.collection.create({ data: { projectId: project.id, slug: "sample-basics", name: "Basics", sample: true } });
  expect(await retry()).not.toHaveProperty("labels");
  expect(labelIn(await collection("billing"), "de")).toBeNull();
  expect(model.requests).toHaveLength(0);
});

test("a collection written another way (an import, Autopilot) is found and translated by the retry job", async () => {
  await german();
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported", description: "From elsewhere." } });
  model.reply(labelsReply({ "0.n": "Importiert", "0.d": "Von woanders." }));
  expect(await retry()).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("imported"), "de")).toEqual({ name: "Importiert", description: "Von woanders." });
});

test("Retranslate makes the labels kept up to date again; one failing its checks waits, the others are written", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  model.reply(labelsReply({ "0.n": "Einrichtung" }));
  await settled(call(createCollection, as(), { name: "Setup", description: "" }));
  // Billing comes back translated; Setup comes back empty twice (its check fails, then its retry's).
  model.reply(labelsReply({ "0.n": "Zahlung", "1.n": "" }));
  model.reply(labelsReply({ "1.n": "" }));
  await settled(call(retranslateLanguage, as(), { code: "de" }));
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Zahlung");
  expect(labelIn(await collection("setup"), "de")).toBeNull();
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 1, labelsRetryAt: expect.any(Date) });
});

test("the product setting changing between a label's translating and its write: nothing written, the labels made again under the new one", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] }));
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
  // Nothing failed: nothing waits.
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsTries: 0, labelsRetryAt: null });
});

test("renaming a tab translates it again", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Anleitungen" }));
  await settled(call(createTab, as(), { name: "Guides" }));
  model.reply(labelsReply({ "0.n": "Hilfe" }));
  await settled(call(updateTab, as(), { slug: "guides", name: "Help" }));
  expect(labelIn(await tab("help"), "de")?.name).toBe("Hilfe");
});

test("Retranslate while a labels job translates: that job writes nothing, the label is made again", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => call(retranslateLanguage, as(), { code: "de" }));
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
});

test("a removed language's label translations go with it: added again, its labels are translated anew", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  await settled(call(updateLanguages, as(), { languages: [] }));
  expect((await collection("billing")).translations).toEqual({});
  model.reply(labelsReply({ "0.n": "Zahlungen" }));
  await german();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Zahlungen");
});

test("a language removed and added again while a labels job translates: that job writes nothing, the label is made anew", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }), async () => {
    // Not waiting for what they queue: the job they'd wait for is this one.
    await call(updateLanguages, as(), { languages: [] });
    await call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] });
  });
  model.reply(labelsReply({ "0.n": "Abrechnung (neu)" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
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
  await languageTranslationsDone();
  expect((await collection("billing")).translations).toEqual({});
});

test("a collection's description changing on its own is translated again at once", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen." }));
  await settled(call(createCollection, as(), { name: "Billing", description: "Paying." }));
  model.reply(labelsReply({ "0.n": "Abrechnung", "0.d": "Bezahlen und Rechnungen." }));
  await settled(call(updateCollection, as(), { slug: "billing", description: "Paying and invoices." }));
  expect(labelIn(await collection("billing"), "de")).toEqual({ name: "Abrechnung", description: "Bezahlen und Rechnungen." });
});

test("a languages save that removes one language and changes another waits for a label write under way: no deadlock", async () => {
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  model.reply(labelsReply({ "0.n": "Facturation" }));
  await settled(call(updateLanguages, as(), { languages: [{ code: "de" }, { code: "fr" }] }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
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
  await languageTranslationsDone();
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
    expect(await retry()).not.toHaveProperty("labels");
  } finally {
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" RESET timezone`);
    await prisma.$disconnect();
  }
});

test("the retry job claims a language it queues: a run while its job is still translating doesn't queue it again", async () => {
  await german();
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported" } });
  let again: unknown;
  model.reply(labelsReply({ "0.n": "Importiert" }), async () => {
    again = await handlers.retryArticleTranslations({}, log);
  });
  expect(await retry()).toMatchObject({ labels: 1 });
  expect(again).not.toHaveProperty("labels");
  expect(labelIn(await collection("imported"), "de")?.name).toBe("Importiert");
  // Done: its time cleared, nothing waits.
  expect(await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ labelsRetryAt: null });
});

test("a save never waits for its labels' translating: the model answers only once the save is back", async () => {
  await german();
  let back!: () => void;
  const saved = new Promise<void>((resolve) => (back = resolve));
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => saved);
  await call(createCollection, as(), { name: "Billing", description: "" });
  back();
  await languageTranslationsDone();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung");
});

test("the retry job's queuing failing after its claim: the language is tried again at the next run but one, not a day later", async () => {
  await german();
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported" } });
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  expect(await retry()).toMatchObject({ labels: 1 });
  vi.stubEnv("JOBS_DRIVER", "inline");
  const { labelsRetryAt } = await prisma.projectLanguage.findFirstOrThrow({ where: { projectId: project.id } });
  expect(labelsRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
  // Its time come, the next run queues it.
  await prisma.projectLanguage.updateMany({ where: { projectId: project.id }, data: { labelsRetryAt: new Date(Date.now() - 1000) } });
  model.reply(labelsReply({ "0.n": "Importiert" }));
  expect(await retry()).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("imported"), "de")?.name).toBe("Importiert");
});

test("collections made one after another while a labels job translates: the next run waits for it, so each label is sent once", async () => {
  await german();
  // Setup is made while Billing's translation is on its way: its run goes after, with Setup alone.
  model.reply(labelsReply({ "0.n": "Abrechnung" }), () => call(createCollection, as(), { name: "Setup", description: "" }));
  model.reply(labelsReply({ "0.n": "Einrichtung" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  const sent = model.requests.map((request) => String(request.messages.at(-1)!.content));
  expect(sent.filter((text) => text.includes('"Billing"'))).toHaveLength(1);
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung");
  expect(labelIn(await collection("setup"), "de")?.name).toBe("Einrichtung");
});

test("the retry job's claim while a languages save holds one of the languages: it takes the other, and neither waits on the other", async () => {
  // French first, so its row comes first in the table (where a plain update would lock it first).
  await settled(call(updateLanguages, as(), { languages: [{ code: "fr" }] }));
  await settled(call(updateLanguages, as(), { languages: [{ code: "fr" }, { code: "de" }] }));
  await prisma.collection.create({ data: { projectId: project.id, slug: "imported", name: "Imported" } });
  // A save held open as languages.update takes its rows (by code): German's, then (once let go) French's.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const saving = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM project_language WHERE "projectId" = ${project.id} AND code = 'de' FOR UPDATE`;
      held();
      await gate;
      await tx.$queryRaw`SELECT 1 FROM project_language WHERE "projectId" = ${project.id} AND code = 'fr' FOR UPDATE`;
    },
    { timeout: 20_000 },
  );
  await holding;
  model.otherwise(labelsReply({ "0.n": "Importé" }), '"0.n":"Imported"');
  let done = false;
  const retrying = handlers.retryArticleTranslations({}, log).finally(() => (done = true));
  // Let the save go once the retry is done, or waiting on a lock.
  for (let i = 0; i < 100 && !done; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(count) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  const [, result] = await Promise.all([saving, retrying]);
  await languageTranslationsDone();
  // French claimed and translated; German, held, is the next run's.
  expect(result).toMatchObject({ labels: 1 });
  expect(labelIn(await collection("imported"), "fr")?.name).toBe("Importé");
});

test("Retranslate while collections are being moved: it waits for the move (the project's lock first), no deadlock", async () => {
  await german();
  model.reply(labelsReply({ "0.n": "Abrechnung" }));
  await settled(call(createCollection, as(), { name: "Billing", description: "" }));
  model.reply(labelsReply({ "0.n": "Einrichtung" }));
  await settled(call(createCollection, as(), { name: "Setup", description: "" }));
  const [billing, setup] = [await collection("billing"), await collection("setup")];
  // A move held open as collections.reorder makes it: the project's lock, then Setup's row, then (once let go) Billing's.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const moving = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      await tx.$queryRaw`SELECT 1 FROM collection WHERE id = ${setup.id} FOR UPDATE`;
      held();
      await gate;
      await tx.$queryRaw`SELECT 1 FROM collection WHERE id = ${billing.id} FOR UPDATE`;
    },
    { timeout: 20_000 },
  );
  await holding;
  model.otherwise(labelsReply({ "0.n": "Abrechnung (neu)", "1.n": "Einrichtung (neu)" }), '"0.n":"Billing"');
  let done = false;
  const retranslating = call(retranslateLanguage, as(), { code: "de" }).finally(() => (done = true));
  for (let i = 0; i < 100 && !done; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(count) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await Promise.all([moving, retranslating]);
  await languageTranslationsDone();
  expect(labelIn(await collection("billing"), "de")?.name).toBe("Abrechnung (neu)");
});

test("Retranslate as the language is being removed: it waits for the removal, then says the language is gone, queuing nothing", async () => {
  await german();
  // A removal held open as languages.update makes it: the project's lock, the language's row deleted.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const removing = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      await tx.projectLanguage.deleteMany({ where: { projectId: project.id, code: "de" } });
      held();
      await gate;
    },
    { timeout: 20_000 },
  );
  await holding;
  let done = false;
  const retranslating = call(retranslateLanguage, as(), { code: "de" }).then(
    () => null,
    (error: unknown) => error,
  );
  void retranslating.finally(() => (done = true));
  for (let i = 0; i < 100 && !done; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(count) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await removing;
  expect(await retranslating).toMatchObject({ status: 404 });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(0);
});
