import { type Doc, segmentsOf, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle, updateArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { getTranslation, publishTranslation, saveTranslation, updateTranslationSections } from "./operations/translations";

/** Retranslating and unpublished changes (docs/plan.md, Languages, L6 part three). */

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

/** An article's text: an intro, then sections by heading. */
const doc = (intro: string, ...parts: [string, string][]): Doc => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: intro }] },
    ...parts.flatMap(([heading, text]) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ]),
  ],
});
const V1 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card"]);

/** The model's answer for "Getting paid" with `content`: `[tag] ` before each segment. */
const reply = (content: Doc, tag: string) => {
  const { segments } = segmentsOf(translationSource({ title: "Getting paid", description: "", keywords: [], body: "", content }).doc);
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
};

const de = { slug: "getting-paid", language: "de" as const };
const text = (content: unknown) => toPlainText(content as Doc);

/** "Getting paid" published, and translated into German (kept up to date). */
async function translated() {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  model.reply(reply(V1, "de"));
  await call(publishArticle, as(), { slug: "getting-paid" });
  await languageTranslationsDone();
}

/** Publishes `content` as the article's text, answering the retranslation with `tag`. */
async function republish(content: Doc, tag: string) {
  model.reply(reply(content, tag));
  await call(updateArticle, as(), { slug: "getting-paid", content, publish: true });
  await languageTranslationsDone();
}

/** The team edits the German draft's Billing section. */
async function editBilling() {
  const version = await call(getTranslation, as(), de);
  const content = structuredClone(version.content) as Doc;
  content.content!.at(-1)!.content![0]!.text = "Unsere Abrechnung";
  return call(saveTranslation, as(), { ...de, content, version: version.version });
}

test("publishing after a retranslation takes the new translation in a section the team edited whose source changed", async () => {
  await translated();
  await editBilling();
  // English changes in Setup and Billing: the published text takes the new translation everywhere; the draft everywhere but
  // the team's Billing, which is now behind.
  const V2 = doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  await republish(V2, "de2");
  const before = await call(getTranslation, as(), de);
  expect(text(before.content)).toContain("[de2] Pay by card or invoice");
  expect(text(before.draft!.content)).toContain("[de2] Install it now");
  expect(text(before.draft!.content)).toContain("Unsere Abrechnung");
  expect(before.draft!.behind).toHaveLength(1);
  expect(before.behind).toEqual([]);

  const published = await call(publishTranslation, as(), de);
  expect(text(published.content)).toContain("[de2] Pay by card or invoice");
  expect(text(published.content)).not.toContain("Unsere Abrechnung");
  expect(published).toMatchObject({ draft: null, behind: [] });
});

test("kept, the edit stays the team's and behind, through later retranslations too, until Update those sections", async () => {
  await translated();
  await editBilling();
  await republish(doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), "de2");
  const billing = (await call(getTranslation, as(), de)).draft!.behind[0]!;

  const published = await call(publishTranslation, as(), { ...de, keep: [billing] });
  expect(text(published.content)).toContain("Unsere Abrechnung");
  expect(published.behind).toEqual([{ section: billing, reason: "English changed in this section since it was edited." }]);

  // English changes elsewhere: kept up to date, the rest is retranslated, the team's Billing stays (and stays behind).
  const V3 = doc("Intro, again", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await republish(V3, "de3");
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("[de3] Intro, again");
  expect(text(after.content)).toContain("Unsere Abrechnung");
  expect(after.behind.map(({ section }) => section)).toEqual([billing]);

  // Update those sections: translated again from the source, no longer the team's. Its English was translated before (when
  // the draft was retranslated), so nothing is asked of the model: the remembered translation is used.
  await call(updateTranslationSections, as(), de);
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(3);
  const updated = await call(getTranslation, as(), de);
  expect(text(updated.content)).not.toContain("Unsere Abrechnung");
  expect(text(updated.content)).toContain("[de2] Pay by card or invoice");
  expect(updated.behind).toEqual([]);
});

test("a version the team writes: the source changing puts its sections behind, and Update those sections translates only those", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  await call(publishArticle, as(), { slug: "getting-paid" });
  const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const ours = doc("Hallo", ["Einrichtung", "Unsere Installation"], ["Abrechnung", "Unsere Zahlung"]);
  // Written against the English as it is now (as saving and publishing it record).
  const stored = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  const sections = sourceSections(translationSource(stored).text).map(({ key, hash }) => ({ key, hash }));
  await prisma.articleTranslation.create({ data: { articleId, projectId: project.id, language: "de", automatic: false, title: "Bezahlt werden", content: ours, sections, publishedAt: new Date() } });
  expect((await call(getTranslation, as(), de)).behind).toEqual([]);

  // Nothing is translated on publish (the team writes it), but Billing is now behind.
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  await languageTranslationsDone();
  const behind = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  expect(behind).toHaveLength(1);

  model.reply(reply(V2, "de2"));
  await call(updateTranslationSections, as(), { ...de, sections: behind });
  await languageTranslationsDone();
  const updated = await call(getTranslation, as(), de);
  expect(text(updated.content).split("\n").filter(Boolean)).toEqual(["Hallo", "Einrichtung", "Unsere Installation", "[de2] Billing", "[de2] Pay by card or invoice"]);
  expect(updated).toMatchObject({ title: "Bezahlt werden", behind: [] });
});

test("a draft saved while the job translates is kept: the job writes around the team's sections as they are when it writes", async () => {
  await translated();
  const V2 = doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card"]);
  model.reply(reply(V2, "de2"), () => editBilling());
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.draft!.content)).toContain("Unsere Abrechnung");
  expect(text(after.draft!.content)).toContain("[de2] Install it now");
  // Its source didn't change since the edit: not behind.
  expect(after.draft!.behind).toEqual([]);
});

test("publishing with nothing to publish, or a version that isn't there, says so", async () => {
  await translated();
  await expect(call(publishTranslation, as(), de)).rejects.toMatchObject({ status: 409, code: "no_changes" });
  await expect(call(getTranslation, as(), { ...de, language: "fr" })).rejects.toMatchObject({ status: 404 });
  await expect(call(updateTranslationSections, as(), de)).rejects.toMatchObject({ status: 409, code: "nothing_behind" });
});

/** The team edits the German draft's Setup section (its second paragraph) and publishes it. */
async function publishOwnSetup(title?: string) {
  const version = await call(getTranslation, as(), de);
  const content = structuredClone(version.content) as Doc;
  content.content![2]!.content![0]!.text = "Unsere Einrichtung";
  await call(saveTranslation, as(), { ...de, content, version: version.version, ...(title && { title }) });
  return call(publishTranslation, as(), de);
}

test("published, the team's edits on a version kept up to date stay theirs until their English changes, as does its title", async () => {
  await translated();
  expect(text((await publishOwnSetup("Bezahlung")).content)).toContain("Unsere Einrichtung");
  // English changes elsewhere: Setup and the title stay the team's.
  await republish(doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), "de2");
  let now = await call(getTranslation, as(), de);
  expect(text(now.content)).toContain("Unsere Einrichtung");
  expect(text(now.content)).toContain("[de2] Pay by card or invoice");
  expect(now.title).toBe("Bezahlung");
  // Setup's English changes: the new translation replaces the edit there (Keep up to date), and nothing is behind.
  await republish(doc("Intro", ["Setup", "Install it today"], ["Billing", "Pay by card or invoice"]), "de3");
  now = await call(getTranslation, as(), de);
  expect(text(now.content)).toContain("[de3] Install it today");
  expect(now.behind).toEqual([]);
  // The English title changes: the translated one replaces the team's.
  model.reply(reply(doc("Intro", ["Setup", "Install it today"], ["Billing", "Pay by card or invoice"]), "de4").replace("[de4] Getting paid", "[de4] Getting paid fast"));
  await call(updateArticle, as(), { slug: "getting-paid", title: "Getting paid fast", publish: true });
  await languageTranslationsDone();
  expect((await call(getTranslation, as(), de)).title).toBe("[de4] Getting paid fast");
});

/** A version of "Getting paid" the team writes, made against the English as published now. */
async function manualVersion() {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  await call(publishArticle, as(), { slug: "getting-paid" });
  const stored = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const sections = sourceSections(translationSource(stored).text).map(({ key, hash }) => ({ key, hash }));
  const ours = doc("Hallo", ["Einrichtung", "Unsere Installation"], ["Abrechnung", "Unsere Zahlung"]);
  await prisma.articleTranslation.create({ data: { articleId: stored.id, projectId: project.id, language: "de", automatic: false, title: "Bezahlt werden", content: ours, sections, publishedAt: new Date() } });
  return stored.id;
}

test("sections asked for while the job translates are kept for its next run, which it queues", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  await languageTranslationsDone();
  const [setup, billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Billing asked for; while it's being translated, Setup too (as a second request writes it).
  model.reply(reply(V2, "de2"), () => prisma.articleTranslation.updateMany({ where: { articleId }, data: { updateSections: [billing!, setup!] } }));
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("[de2] Install it now");
  expect(text(after.content)).toContain("[de2] Pay by card or invoice");
  expect(after.behind).toEqual([]);
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ updateSections: [] });
});

test("a version the team writes with sections waiting to update is tried again by the retry job", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Asked for, but its job was lost: its safety net's time has passed.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { updateSections: [billing!], retryAt: new Date(Date.now() - 1000) } });
  model.reply(reply(V2, "de2"));
  expect(await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} })).toMatchObject({ queued: 1 });
  await languageTranslationsDone();
  expect(text((await call(getTranslation, as(), de)).content)).toContain("[de2] Pay by card or invoice");
});

test("an edit saved while the job updates that section stays the team's", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  model.reply(reply(V2, "de2"), async () => {
    const now = await call(getTranslation, as(), de);
    const content = structuredClone(now.content) as Doc;
    content.content!.at(-1)!.content![0]!.text = "Neu von uns";
    await call(saveTranslation, as(), { ...de, content, version: now.version });
  });
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.draft!.content)).toContain("Neu von uns");
  expect(text(after.content)).toContain("[de2] Pay by card or invoice");
  expect(articleId).toBeTruthy();
});

test("a draft keeps the team's published title when the job retranslates it", async () => {
  await translated();
  await publishOwnSetup("Bezahlung");
  // A draft that changes only the text.
  const now = await call(getTranslation, as(), de);
  const content = structuredClone(now.content) as Doc;
  content.content![0]!.content![0]!.text = "Hallo";
  await call(saveTranslation, as(), { ...de, content, version: now.version });
  await republish(doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), "de2");
  expect((await call(getTranslation, as(), de)).draft!.title).toBe("Bezahlung");
});

test("sections asked for with no time to try again (a job the previous release skipped) are queued by the retry job", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { updateSections: [billing!], retryAt: null } });
  model.reply(reply(V2, "de2"));
  expect(await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} })).toMatchObject({ queued: 1 });
  await languageTranslationsDone();
  expect(text((await call(getTranslation, as(), de)).content)).toContain("[de2] Pay by card or invoice");
});

test("a section behind because its English section went can be updated: it goes", async () => {
  await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const behind = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  expect(behind).toHaveLength(1);
  // Nothing in English changed that's asked for: nothing to translate, Billing's German section goes.
  model.reply(reply(V2, "de2"));
  await call(updateTranslationSections, as(), de);
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content).split("\n").filter(Boolean)).toEqual(["Hallo", "Einrichtung", "Unsere Installation"]);
  expect(after.behind).toEqual([]);
});

test("a save made from an older read is refused: it would undo what changed since", async () => {
  await translated();
  const read = await call(getTranslation, as(), de);
  await republish(doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), "de2");
  await expect(call(saveTranslation, as(), { ...de, content: read.content, version: read.version })).rejects.toMatchObject({ status: 409, code: "changed" });
  expect(text((await call(getTranslation, as(), de)).content)).toContain("[de2] Pay by card or invoice");
});

test("publishing a version the team writes: sections behind take the new translation unless kept", async () => {
  await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  // A draft that edits only the intro: Setup and Billing are behind English in it.
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content![0]!.content![0]!.text = "Guten Tag";
  const saved = await call(saveTranslation, as(), { ...de, content, version: read.version });
  expect(saved.draft!.behind).toHaveLength(2);
  const [setup] = saved.draft!.behind;
  // Setup kept; Billing takes the new translation (translated after publishing).
  model.reply(reply(V2, "de2"));
  await call(publishTranslation, as(), { ...de, keep: [setup!] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content).split("\n").filter(Boolean)).toEqual(["Guten Tag", "Einrichtung", "Unsere Installation", "[de2] Billing", "[de2] Pay by card or invoice"]);
  expect(after.behind.map(({ section }) => section)).toEqual([setup]);
});

test("the retry job leaves sections asked for on an article that isn't published any more", async () => {
  const articleId = await manualVersion();
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { updateSections: ["x"], retryAt: null } });
  await prisma.article.update({ where: { id: articleId }, data: { publishedAt: null } });
  await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ retryAt: null });
});

test("a version the team writes and never published: updating its draft's sections publishes nothing", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  await call(publishArticle, as(), { slug: "getting-paid" });
  const stored = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const sections = sourceSections(translationSource(stored).text).map(({ key, hash }) => ({ key, hash, own: true }));
  const ours = doc("Hallo", ["Einrichtung", "Unsere Installation"], ["Abrechnung", "Unsere Zahlung"]);
  await prisma.articleTranslation.create({ data: { articleId: stored.id, projectId: project.id, language: "de", automatic: false, draft: { title: "Bezahlt werden", titleEdited: true, content: ours, sections } } });
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).draft!.behind;
  model.reply(reply(V2, "de2"));
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const after = await prisma.articleTranslation.findFirstOrThrow({ where: { articleId: stored.id } });
  expect(after).toMatchObject({ publishedAt: null, content: null, slug: null, updateSections: [] });
  expect(text((after.draft as { content: Doc }).content)).toContain("[de2] Pay by card or invoice");
  expect(text((after.draft as { content: Doc }).content)).toContain("Unsere Installation");
});

test("an edit saved while a retranslation waits is behind: it was made from the translation of the English before", async () => {
  await translated();
  // English Billing changes; the provider doesn't answer (asked, then once more), so German keeps its old translation.
  model.fail(500);
  model.fail(500);
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), publish: true });
  await languageTranslationsDone();
  const saved = await editBilling();
  expect(saved.draft!.behind).toHaveLength(1);
});

test("a publish from an older read is refused: it would publish a draft never seen, `keep` meant for other sections", async () => {
  await translated();
  await editBilling();
  const read = await call(getTranslation, as(), de);
  await republish(doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card"]), "de2");
  await expect(call(publishTranslation, as(), { ...de, version: read.version })).rejects.toMatchObject({ status: 409, code: "changed" });
  const now = await call(getTranslation, as(), de);
  expect((await call(publishTranslation, as(), { ...de, version: now.version })).draft).toBeNull();
});

test("Update those sections replaces the team's own text in a section it selects", async () => {
  await manualVersion();
  // The team edits Billing and publishes it: published, it's theirs.
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content!.at(-1)!.content![0]!.text = "Von uns bearbeitet";
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  await call(publishTranslation, as(), de);
  expect(text((await call(getTranslation, as(), de)).content)).toContain("Von uns bearbeitet");
  // Selected explicitly (whether behind or not): the new translation replaces it.
  const stored = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const billing = sourceSections(translationSource(stored).text).at(-1)!.key;
  model.reply(reply(V1, "de2"));
  await call(updateTranslationSections, as(), { ...de, sections: [billing] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("[de2] Pay by card");
  expect(text(after.content)).not.toContain("Von uns bearbeitet");
  expect(text(after.content)).toContain("Unsere Installation");
});
