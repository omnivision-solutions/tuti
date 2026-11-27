import { type Doc, segmentsOf, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle, updateArticle } from "./operations/docs";
import { retranslateLanguage, updateLanguages } from "./operations/languages";
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

/** The model's answer for just these sections ([heading, text], in order): what a version the team writes sends. */
const sectionsReply = (tag: string, ...parts: [string, string][]) => {
  const { segments } = segmentsOf({
    type: "doc",
    content: parts.flatMap(([heading, text]) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ]),
  });
  return JSON.stringify({ segments: Object.fromEntries(segments.map(({ id, text }) => [id, `[${tag}] ${text}`])) });
};

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

  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
  await call(updateTranslationSections, as(), { ...de, sections: behind });
  await languageTranslationsDone();
  // Only Billing was sent: not the title, the intro or Setup (the team's).
  const sent = model.requests.at(-1)!.user;
  expect(sent).toContain("Pay by card or invoice");
  expect(sent).not.toContain("Install it");
  expect(sent).not.toContain("Getting paid");
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]), () => prisma.articleTranslation.updateMany({ where: { articleId }, data: { updateSections: [billing!, setup!] } }));
  model.reply(sectionsReply("de2", ["Setup", "Install it now"]));
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
  expect(await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} })).toMatchObject({ queued: 1 });
  await languageTranslationsDone();
  expect(text((await call(getTranslation, as(), de)).content)).toContain("[de2] Pay by card or invoice");
});

test("an edit saved after asking for a section cancels that request: the edit stays, nothing translated over it", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Asked for; while the job translates it, the team rewrites it in the draft.
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]), async () => {
    const now = await call(getTranslation, as(), de);
    const content = structuredClone(now.content) as Doc;
    content.content!.at(-1)!.content![0]!.text = "Neu von uns";
    await call(saveTranslation, as(), { ...de, content, version: now.version });
  });
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.draft!.content)).toContain("Neu von uns");
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ updateSections: [] });
});

test("a section asked for, then kept on publishing while its translation waits, stays the team's", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Asked for, but the provider doesn't answer (asked, then once more): it waits.
  model.fail(500);
  model.fail(500);
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  // The team edits only the intro, and publishes keeping its Billing as it is (behind English).
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content![0]!.content![0]!.text = "Guten Tag";
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ updateSections: [billing] });
  await call(publishTranslation, as(), { ...de, keep: [billing!] });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ updateSections: [] });
  // The retry job later: nothing left asked for, nothing replaces it.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { retryAt: new Date(Date.now() - 1000) } });
  await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} });
  await languageTranslationsDone();
  expect(text((await call(getTranslation, as(), de)).content)).toContain("Unsere Zahlung");
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
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
  // Nothing in English to translate for it: the model isn't asked.
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
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
  model.reply(sectionsReply("de2", ["Billing", "Pay by card"]));
  await call(updateTranslationSections, as(), { ...de, sections: [billing] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("[de2] Pay by card");
  expect(text(after.content)).not.toContain("Von uns bearbeitet");
  expect(text(after.content)).toContain("Unsere Installation");
});

test("a version never translated can't be published without a title", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  // Its first translation waits (the provider doesn't answer, asked then once more): no title yet.
  model.fail(500);
  model.fail(500);
  await call(publishArticle, as(), { slug: "getting-paid" });
  await languageTranslationsDone();
  const read = await call(getTranslation, as(), de);
  expect(read).toMatchObject({ title: "", publishedAt: null });
  const saved = await call(saveTranslation, as(), { ...de, content: doc("Hallo"), version: read.version });
  await expect(call(publishTranslation, as(), de)).rejects.toMatchObject({ status: 409, code: "no_title" });
  // With one, it can. (Its first translation still waiting, publishing queues it again: answered now.)
  await call(saveTranslation, as(), { ...de, title: "Bezahlt werden", content: doc("Hallo"), version: saved.version });
  model.reply(reply(V1, "de"));
  expect(await call(publishTranslation, as(), de)).toMatchObject({ title: "Bezahlt werden", draft: null });
  await languageTranslationsDone();
  // Published for the first time: named at once, from its title (not left to the retry job).
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ slug: "bezahlt-werden" });
});

test("a version the team writes remembers only what's usable: nothing from before the product setting changed, nothing of old English", async () => {
  const articleId = await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const [setup, billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  model.reply(sectionsReply("de2", ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]));
  await call(updateTranslationSections, as(), { ...de, sections: [setup!, billing!] });
  await languageTranslationsDone();
  // The product setting changes: its translations under the old one aren't to be reused.
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual", productAvailable: true }] });
  model.reply(sectionsReply("on", ["Billing", "Pay by card or invoice"]));
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const before = model.requests.length;
  // Setup next: asked of the model again (not taken from the old setting's memory).
  model.reply(sectionsReply("on", ["Setup", "Install it now"]));
  await call(updateTranslationSections, as(), { ...de, sections: [setup!] });
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(before + 1);
  expect(text((await call(getTranslation, as(), de)).content)).toContain("[on] Install it now");
  // English changes again: what it remembers is only of the English as it is.
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it now"], ["Billing", "Pay by invoice"]), publish: true });
  model.reply(sectionsReply("on", ["Billing", "Pay by invoice"]));
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  const { memory } = await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } });
  expect(Object.keys(memory as object)).not.toContain("Pay by card or invoice");
  expect(Object.keys(memory as object)).toContain("Pay by invoice");
});

test("a version the team writes: a behind section rewritten by hand is up to date, published as it is, nothing translated over it", async () => {
  await manualVersion();
  const V2 = doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const read = await call(getTranslation, as(), de);
  expect(read.behind).toHaveLength(1);
  const content = structuredClone(read.content) as Doc;
  content.content!.at(-1)!.content![0]!.text = "Mit Karte oder auf Rechnung";
  const saved = await call(saveTranslation, as(), { ...de, content, version: read.version });
  expect(saved.draft!.behind).toEqual([]);
  const published = await call(publishTranslation, as(), de);
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(0);
  expect(text(published.content)).toContain("Mit Karte oder auf Rechnung");
  expect(published.behind).toEqual([]);
});

test("a version the team writes: a section English renames or adds is behind, and Update those sections translates it in", async () => {
  await manualVersion();
  // English renames Billing to Payments and adds Refunds.
  const V2 = doc("Intro", ["Setup", "Install it"], ["Payments", "Pay by card"], ["Refunds", "Ask us"]);
  await call(updateArticle, as(), { slug: "getting-paid", content: V2, publish: true });
  const behind = (await call(getTranslation, as(), de)).behind;
  expect(behind.map(({ section, reason }) => [section.split("\u001f")[0], reason])).toEqual([
    ["Billing", "English changed in this section since it was edited."],
    ["Payments", "English has this section, and this version doesn't yet."],
    ["Refunds", "English has this section, and this version doesn't yet."],
  ]);
  model.reply(sectionsReply("de2", ["Payments", "Pay by card"], ["Refunds", "Ask us"]));
  await call(updateTranslationSections, as(), de);
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content).split("\n").filter(Boolean)).toEqual([
    "Hallo",
    "Einrichtung",
    "Unsere Installation",
    "[de2] Payments",
    "[de2] Pay by card",
    "[de2] Refunds",
    "[de2] Ask us",
  ]);
  expect(after.behind).toEqual([]);
});

test("saved with a heading renamed and a section added, the renamed one keeps its source section", async () => {
  const { id: articleId } = await (async () => {
    await translated();
    return prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  })();
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  // Billing's heading renamed (its text as it was), and an FAQ added at the end.
  content.content!.at(-2)!.content![0]!.text = "Zahlung";
  content.content!.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "FAQ" }] }, { type: "paragraph", content: [{ type: "text", text: "Fragen" }] });
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  const { draft } = await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } });
  const { sections, removed } = draft as { sections: { key: string | null }[]; removed: string[] };
  expect(sections.map(({ key }) => key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", "Billing", null]);
  expect(removed).toEqual([]);
});

test("kept up to date: a section asked for, then kept on publishing while its translation waits, is the team's and behind", async () => {
  await translated();
  // The team's own Billing, published; then English changes it and the retranslation can't run.
  await editBilling();
  await call(publishTranslation, as(), de);
  model.fail(500);
  model.fail(500);
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), publish: true });
  await languageTranslationsDone();
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Asked for (no longer the team's), still waiting.
  model.fail(500);
  model.fail(500);
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  // A draft that edits only the intro, published keeping Billing.
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content![0]!.content![0]!.text = "Guten Tag";
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  // Its retranslation still waiting, publishing queues it again: answered now, and it keeps the team's Billing.
  model.reply(reply(doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), "de2"));
  const published = await call(publishTranslation, as(), { ...de, keep: [billing!] });
  await languageTranslationsDone();
  expect(text(published.content)).toContain("Unsere Abrechnung");
  expect(text((await call(getTranslation, as(), de)).content)).toContain("Unsere Abrechnung");
  expect(published.behind.map(({ section }) => section)).toEqual([billing]);
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(row.updateSections).toEqual([]);
  expect((row.sections as { key: string; own?: boolean; kept?: boolean }[]).find(({ key }) => key === billing)).toMatchObject({ own: true, kept: true });
});

test("a section deleted after asking for it isn't put back by the update", async () => {
  const articleId = await manualVersion();
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), publish: true });
  const [billing] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  model.fail(500);
  model.fail(500);
  await call(updateTranslationSections, as(), { ...de, sections: [billing!] });
  await languageTranslationsDone();
  // The team deletes Billing from the draft.
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content = content.content!.slice(0, -2);
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  expect(await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } })).toMatchObject({ updateSections: [] });
  // The retry job later: nothing asked for, Billing not back in the draft.
  await prisma.articleTranslation.updateMany({ where: { articleId }, data: { retryAt: new Date(Date.now() - 1000) } });
  await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} });
  await languageTranslationsDone();
  expect(text((await call(getTranslation, as(), de)).draft!.content)).not.toContain("Unsere Zahlung");
});

test("a request cancelled mid-run keeps the section's other reason to be behind", async () => {
  await manualVersion();
  // "Our product is available in" changes: every section of the team's version is behind for it.
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual", productAvailable: true }] });
  const [, setup] = (await call(getTranslation, as(), de)).behind.map(({ section }) => section);
  // Setup asked for; while it's translated, the team edits it in the draft (cancelling the request).
  model.reply(sectionsReply("de2", ["Setup", "Install it"]), async () => {
    const now = await call(getTranslation, as(), de);
    const content = structuredClone(now.content) as Doc;
    content.content![2]!.content![0]!.text = "Unsere neue Installation";
    await call(saveTranslation, as(), { ...de, content, version: now.version });
  });
  await call(updateTranslationSections, as(), { ...de, sections: [setup!] });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("Unsere Installation");
  expect(after.behind).toContainEqual({ section: setup, reason: "The product's language setting changed." });
});

test("publishing a version makes a translate job already running (the previous release's during a deploy) write nothing, and isn't a Retranslate", async () => {
  await translated();
  await editBilling();
  const before = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } });
  await call(publishTranslation, as(), de);
  await languageTranslationsDone();
  // As the previous release's job writes: only while `retranslate` is what it read.
  const { count } = await prisma.articleTranslation.updateMany({ where: { id: before.id, retranslate: before.retranslate }, data: { title: "Machine" } });
  expect(count).toBe(0);
  const after = await prisma.articleTranslation.findFirstOrThrow({ where: { id: before.id } });
  expect(after.retranslate - after.retranslated).toBe(before.retranslate - before.retranslated);
  expect(text(after.content)).toContain("Unsere Abrechnung");
});

test("a Retranslate running while a draft is published is answered by the run publishing queues again, not left to the retry job", async () => {
  await translated();
  // Retranslate: while its job waits for its answer, the team publishes an edit (that run then writes nothing).
  model.reply(reply(V1, "re"), async () => {
    await editBilling();
    await call(publishTranslation, as(), de);
  });
  model.reply(reply(V1, "re2"));
  await call(retranslateLanguage, as(), { code: "de" });
  await languageTranslationsDone();
  const after = await call(getTranslation, as(), de);
  expect(text(after.content)).toContain("[re2] Intro");
  // The team's Billing, its English unchanged, stays theirs.
  expect(text(after.content)).toContain("Unsere Abrechnung");
  const row = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(row.retranslate).toBe(row.retranslated);
});

test("a save made from a read taken before the English changed is refused: it would mark the section up to date unseen", async () => {
  await manualVersion();
  const read = await call(getTranslation, as(), de);
  // English Billing changes (a version the team writes isn't retranslated: its own text is as it was).
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), publish: true });
  const content = structuredClone(read.content) as Doc;
  content.content!.at(-1)!.content![0]!.text = "Unsere Zahlung!";
  await expect(call(saveTranslation, as(), { ...de, content, version: read.version })).rejects.toMatchObject({ status: 409, code: "changed" });
});

test("publishing a draft makes its new text searchable in its language, the old text's sections gone", async () => {
  await translated();
  await editBilling();
  await call(publishTranslation, as(), de);
  await languageTranslationsDone();
  const { id } = await prisma.articleTranslation.findFirstOrThrow({ where: { projectId: project.id } });
  const chunks = await prisma.articleTranslationChunk.findMany({ where: { translationId: id }, select: { text: true } });
  expect(chunks.map(({ text }) => text).join(" ")).toContain("Unsere Abrechnung");
  expect(chunks.map(({ text }) => text).join(" ")).not.toContain("[de] Pay by card");
});

test("a version the team writes whose search data couldn't be written on publishing is embedded by the retry job", async () => {
  const articleId = await manualVersion();
  const read = await call(getTranslation, as(), de);
  const content = structuredClone(read.content) as Doc;
  content.content![0]!.content![0]!.text = "Guten Tag";
  await call(saveTranslation, as(), { ...de, content, version: read.version });
  // The embeddings provider fails as it's published: no search sections, a time to try again.
  model.embeddings.failNext(500);
  await call(publishTranslation, as(), de);
  const waiting = await prisma.articleTranslation.findFirstOrThrow({ where: { articleId } });
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: waiting.id } })).toBe(0);
  expect(waiting.tries).toBe(1);
  // The retry job, once it's due: embedded, nothing translated.
  await prisma.articleTranslation.update({ where: { id: waiting.id }, data: { retryAt: new Date(Date.now() - 1000) } });
  await handlers.retryArticleTranslations({}, { info: () => {}, warn: () => {} });
  await languageTranslationsDone();
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: waiting.id } })).toBeGreaterThan(0);
  expect(model.requests).toHaveLength(0);
});

test("a version the team writes and never published: only its draft is compared, so an update with no list translates only the section English changed", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Getting paid", content: V1 });
  await call(publishArticle, as(), { slug: "getting-paid" });
  const stored = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const sections = sourceSections(translationSource(stored).text).map(({ key, hash }) => ({ key, hash, own: true }));
  const ours = doc("Hallo", ["Einrichtung", "Unsere Installation"], ["Abrechnung", "Unsere Zahlung"]);
  await prisma.articleTranslation.create({ data: { articleId: stored.id, projectId: project.id, language: "de", automatic: false, draft: { title: "Bezahlt werden", titleEdited: true, content: ours, sections } } });
  await call(updateArticle, as(), { slug: "getting-paid", content: doc("Intro", ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]), publish: true });
  const read = await call(getTranslation, as(), de);
  expect(read.behind.map(({ section }) => section.split("\u001f")[0])).toEqual(["Billing"]);
  expect(read.draft!.behind.map((section) => section.split("\u001f")[0])).toEqual(["Billing"]);
  model.reply(sectionsReply("de2", ["Billing", "Pay by card or invoice"]));
  await call(updateTranslationSections, as(), de);
  await languageTranslationsDone();
  expect(model.requests).toHaveLength(1);
  const draft = text((await call(getTranslation, as(), de)).draft!.content);
  expect(draft).toContain("Hallo");
  expect(draft).toContain("Unsere Installation");
  expect(draft).toContain("[de2] Pay by card or invoice");
});

test("a sample article's version the team publishes is never made searchable", async () => {
  await translated();
  await prisma.article.updateMany({ where: { projectId: project.id }, data: { sample: true } });
  await editBilling();
  await call(publishTranslation, as(), de);
  await languageTranslationsDone();
  expect(await prisma.articleTranslationChunk.count({ where: { projectId: project.id } })).toBe(0);
});
