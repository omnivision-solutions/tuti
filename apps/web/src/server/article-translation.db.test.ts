import { segmentsOf } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers, languageTranslationsDone, PRODUCT_SETTING_CHANGED, retryDelay, translateArticle, translationSource } from "@tuti/jobs";
import { creditsOn, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle, updateArticle } from "./operations/docs";
import { getLanguages, retranslateLanguage, updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Article translations (docs/plan.md, Languages, L6): the translate-article job, run inline. */

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

/** languages.update and languages.retranslate, once the translating they start (in the background, inline) is done. */
const languages = async (input: Parameters<typeof updateLanguages.run>[1]) => {
  const result = await call(updateLanguages, as(), input);
  await languageTranslationsDone();
  return result;
};
const retranslate = async (input: Parameters<typeof retranslateLanguage.run>[1]) => {
  const result = await call(retranslateLanguage, as(), input);
  await languageTranslationsDone();
  return result;
};

/** Publishes "Getting started", once its translating (in the background, inline) is done. */
const publish = async () => {
  await call(publishArticle, as(), { slug: "getting-started" });
  await languageTranslationsDone();
};

const BODY = "Open Settings and click New project.\n\nPick a plan that fits your team.";

/** A reply translating every segment of "Getting started" with `body`: `[tag] ` before each one's text. */
function reply(tag = "de", body = BODY) {
  const { segments } = segmentsOf(translationSource({ title: "Getting started", description: "How to start", keywords: ["setup"], body, content: null }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
}

/** A draft "Getting started", with a description and keywords. */
async function draft() {
  await call(createArticle, as(), { title: "Getting started", body: BODY });
  await prisma.article.updateMany({ where: { projectId: project.id }, data: { description: "How to start", keywords: ["setup"] } });
}

const translation = (language = "de") => prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id, language } });

test("publishing translates into each language kept up to date, its title, description, keywords and text, charged as Translation", async () => {
  await languages({ languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] });
  await draft();
  model.reply(reply());
  await publish();

  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.system).toContain("from English into German");
  // The product isn't available in German: its words stay as written.
  expect(model.requests[0]!.system).toContain("keep the names of its buttons");
  const de = await translation();
  expect(de).toMatchObject({ title: "[de] Getting started", description: "[de] How to start", keywords: ["[de] setup"], error: null, productAvailable: false });
  expect(de.body).toContain("[de] Open Settings and click New project.");
  expect(de.publishedAt).not.toBeNull();
  // Manual for new pages: the team writes French.
  expect(await prisma.articleTranslation.count({ where: { projectId: project.id, language: "fr" } })).toBe(0);
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } })).toEqual([{ feature: "translation" }]);
  expect((await call(getLanguages, as(), {})).languages[0]).toMatchObject({ code: "de", articles: { translated: 1, waiting: 0, why: null } });

  // Publishing again sends only what changed.
  const changed = "Open Settings and click New project.\n\nPick any plan.";
  model.reply(reply("de", changed));
  await call(updateArticle, as(), { slug: "getting-started", body: changed, publish: true });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]!.user).toContain("Pick any plan.");
  expect(model.requests[1]!.user).not.toContain("Open Settings");
  expect((await translation()).body).toContain("[de] Pick any plan.");
});

test("adding a language translates every published article; Retranslate sends everything again", async () => {
  await draft();
  await publish();
  model.reply(reply());
  await languages({ languages: [{ code: "de" }] });
  expect(await translation()).toMatchObject({ title: "[de] Getting started" });

  model.reply(reply("de2"));
  expect(await retranslate({ code: "de" })).toEqual({ queued: 1 });
  expect(model.requests.at(-1)!.user).toContain("Open Settings");
  expect(await translation()).toMatchObject({ title: "[de2] Getting started" });
  await expect(call(retranslateLanguage, as(), { code: "it" })).rejects.toMatchObject({ status: 404 });
});

test("the product setting changing: versions kept up to date retranslated anew under it, manual ones marked behind", async () => {
  await languages({ languages: [{ code: "de" }] });
  await draft();
  model.reply(reply());
  await publish();
  // A version the team writes.
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  await prisma.projectLanguage.create({ data: { projectId: project.id, code: "fr", automatic: false } });
  await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "fr", automatic: false, title: "Bien démarrer", publishedAt: new Date() } });

  model.reply(reply("on"));
  await languages({ languages: [{ code: "de", productAvailable: true }, { code: "fr", productAvailable: true }] });
  const asked = model.requests.at(-1)!;
  expect(asked.system).toContain("translate the names of its buttons");
  // The memory came from the other setting: nothing of it is reused.
  expect(asked.user).toContain("Open Settings");
  expect(await translation()).toMatchObject({ title: "[on] Getting started", productAvailable: true });
  const fr = await translation("fr");
  expect(fr.title).toBe("Bien démarrer");
  expect(Object.values(fr.behind as Record<string, string>)).toEqual([PRODUCT_SETTING_CHANGED]);
  // Set again to what it is: nothing to do.
  await languages({ languages: [{ code: "de", productAvailable: true }, { code: "fr" }] });
  expect(model.requests).toHaveLength(2);
});

test("the setting changing between a job's translating and its write: it writes nothing, the switch's own job writes", async () => {
  await languages({ languages: [{ code: "de" }] });
  await draft();
  model.reply(reply());
  await publish();

  // Retranslate's job is waiting for its answer when the switch changes; the switch's job is answered first.
  model.reply(reply("stale"), () => call(updateLanguages, as(), { languages: [{ code: "de", productAvailable: true }] }));
  model.reply(reply("on"));
  await retranslate({ code: "de" });
  expect(model.requests).toHaveLength(3);
  expect(model.requests[2]!.system).toContain("translate the names of its buttons");
  expect(await translation()).toMatchObject({ title: "[on] Getting started", productAvailable: true });
});

test("a job queued under the old setting stops before asking anything", async () => {
  await languages({ languages: [{ code: "de" }] });
  await draft();
  model.reply(reply());
  await publish();
  const { articleId } = await translation();
  // As a job would see it partway: the setting counted a change since it read it (its first read, mocked to the old one).
  const findUnique = prisma.articleTranslation.findUnique.bind(prisma.articleTranslation);
  const spy = vi.spyOn(prisma.articleTranslation, "findUnique").mockImplementation((async (args: Parameters<typeof findUnique>[0]) => {
    const row = (await findUnique(args)) as { projectLanguage: { productVersion: number } } | null;
    return row && { ...row, projectLanguage: { ...row.projectLanguage, productVersion: row.projectLanguage.productVersion - 1 } };
  }) as never);
  try {
    expect(await translateArticle({ articleId, language: "de", fresh: true }, log)).toEqual({ skipped: "the product's language setting changed" });
  } finally {
    spy.mockRestore();
  }
  expect(model.requests).toHaveLength(1);
});

test("can't run: provider failures are retried, then the page waits with why and is tried again on its own; out of credits too", async () => {
  await languages({ languages: [{ code: "de" }] });
  await draft();
  // Inline, the job's first run is its last try: the provider failing (asked, then asked again once), the page waits.
  model.fail(500);
  model.fail(500);
  await publish();
  const { articleId } = await translation();
  expect(await translation()).toMatchObject({ publishedAt: null, error: "The translation provider didn't answer", tries: 1 });
  // Not the last try: thrown for Hatchet's retry.
  model.fail(500);
  model.fail(500);
  await expect(translateArticle({ articleId, language: "de" }, log, { lastTry: false })).rejects.toThrow("didn't answer");
  model.fail(500);
  model.fail(500);
  expect(await translateArticle({ articleId, language: "de" }, log)).toEqual({ failed: "The translation provider didn't answer" });
  const waiting = await translation();
  expect(waiting).toMatchObject({ publishedAt: null, error: "The translation provider didn't answer", tries: 2 });
  expect(waiting.retryAt!.getTime()).toBeGreaterThan(Date.now());
  expect((await call(getLanguages, as(), {})).languages[0]!.articles).toEqual({ translated: 0, waiting: 1, why: "The translation provider didn't answer" });

  // Not due yet: left alone. Due: tried again.
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { retryAt: new Date(Date.now() - 1000) } });
  model.requests.length = 0;
  model.reply(reply());
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  expect(await translation()).toMatchObject({ title: "[de] Getting started", error: null, retryAt: null });
  // Try again queues only those waiting: none now.
  expect(await retranslate({ code: "de", waiting: true })).toEqual({ queued: 0 });

  // Out of credits: the model isn't asked.
  model.requests.length = 0;
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  expect(await translateArticle({ articleId, language: "de", fresh: true }, log)).toEqual({ failed: "Out of credits" });
  expect(model.requests).toHaveLength(0);
  expect(await translation()).toMatchObject({ title: "[de] Getting started", error: "Out of credits", tries: 1 });
});

test("tried again on its own after 15 minutes, twice as long each time, up to a day", () => {
  expect([1, 2, 3, 7, 100].map(retryDelay)).toEqual([15, 30, 60, 960, 1440].map((minutes) => minutes * 60_000));
});

test("on its last try, any other error marks the page as waiting, to be tried again in a day", async () => {
  await languages({ languages: [{ code: "de" }] });
  await draft();
  model.reply(reply());
  await publish();
  const { articleId } = await translation();
  model.reply(reply("again"));
  // Its write fails (the database, say): thrown for Hatchet's retry before the last try, kept on the page on it.
  const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("database blip"));
  try {
    model.reply(reply("again"));
    await expect(translateArticle({ articleId, language: "de", fresh: true }, log, { lastTry: false })).rejects.toThrow("database blip");
    const before = Date.now();
    expect(await translateArticle({ articleId, language: "de", fresh: true }, log)).toEqual({ failed: "error" });
    const waiting = await translation();
    expect(waiting).toMatchObject({ title: "[de] Getting started", error: "Couldn't translate it", tries: 1 });
    expect(waiting.retryAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
  } finally {
    spy.mockRestore();
  }
});

test("a translation that can't be queued, or whose job is lost, waits and is queued again by the retry job", async () => {
  await draft();
  await publish();
  // Hatchet can't be reached when German is added: the page waits with a time to try again.
  vi.stubEnv("JOBS_DRIVER", "hatchet");
  vi.stubEnv("HATCHET_CLIENT_TOKEN", "not-a-token");
  await languages({ languages: [{ code: "de" }] });
  vi.stubEnv("JOBS_DRIVER", "inline");
  const waiting = await translation();
  expect(waiting).toMatchObject({ publishedAt: null, error: "Couldn't translate it" });
  expect(waiting.retryAt!.getTime()).toBeGreaterThan(Date.now());
  expect((await call(getLanguages, as(), {})).languages[0]!.articles).toMatchObject({ waiting: 1, why: "Couldn't translate it" });

  // Due: queued again and translated, nothing left to try.
  await prisma.articleTranslation.updateMany({ where: { projectId: project.id }, data: { retryAt: new Date(Date.now() - 1000) } });
  model.reply(reply());
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  expect(await translation()).toMatchObject({ title: "[de] Getting started", error: null, retryAt: null });

  // A job lost after it was queued (no error, its safety net's time passed) is queued again; up to date, it ends there.
  await prisma.articleTranslation.updateMany({ where: { projectId: project.id }, data: { retryAt: new Date(Date.now() - 1000) } });
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 1 });
  expect(await translation()).toMatchObject({ retryAt: null });
  expect(await handlers.retryArticleTranslations({}, log)).toEqual({ queued: 0 });
});

test("pages a language queues all get their safety net before the first is translated, so a restart partway strands none", async () => {
  await draft();
  await publish();
  await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
  await call(publishArticle, as(), { slug: "billing" });
  let during: { retryAt: Date | null }[] = [];
  // While a page is being translated (whichever is first), as a restart would find them.
  const look = async () => {
    if (during.length > 0) return;
    during = await prisma.articleTranslation.findMany({ where: { projectId: project.id }, select: { retryAt: true } });
  };
  model.reply(reply(), look, "Pick a plan");
  model.reply(JSON.stringify({ segments: { "1": "[de] Billing", "2": "[de] Pay by card." } }), look, "Pay by card");
  await languages({ languages: [{ code: "de" }] });
  expect(during).toHaveLength(2);
  expect(during.every(({ retryAt }) => retryAt !== null && retryAt.getTime() > Date.now())).toBe(true);
  expect(await prisma.articleTranslation.count({ where: { projectId: project.id, retryAt: null } })).toBe(2);
});
