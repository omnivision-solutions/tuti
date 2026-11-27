import { type Doc, toChunks } from "@tuti/content";
import { prisma } from "@tuti/db";
import { embedTranslation } from "@tuti/jobs";
import { articleChunkText } from "@tuti/shared";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { portalAddress } from "./custom-domains";
import { askDocs, searchDocsAsTyped } from "./docs-readers";
import { searchForReader } from "./docs-search";
import { answerQuestion } from "./operations/docs-ask";
import { createArticle, publishArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** Search and AI answers in the reader's language, citing its articles (docs/plan.md L10). */

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const log = { info: () => {}, warn: () => {} };
/** A unit vector with exactly `similarity` to the question's (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

/** A page's request at `language`'s address, as proxy.ts sends it on (null: the default language's). */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });

/** A published article; with `german`, its German version (written by the team, so current; `stale`: one kept up to date made from an older English). */
async function article(title: string, body: string, german?: { title: string; slug: string; body: string; stale?: true }) {
  const { slug } = await call(createArticle, as(), { title, body });
  await call(publishArticle, as(), { slug });
  if (german) {
    const { id: articleId } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug } });
    const { id } = await prisma.articleTranslation.create({
      data: {
        articleId,
        projectId: project.id,
        language: "de",
        title: german.title,
        slug: german.slug,
        body: german.body,
        publishedAt: new Date(),
        ...(german.stale ? { automatic: true, sourceHash: "an older English" } : { automatic: false }),
      },
    });
    return { slug, versionId: id };
  }
  return { slug, versionId: null };
}

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.headers = {};
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const search = (query: string) => searchForReader(project.id, project.slug, query, 10);

test("searching at a language's address: its translations, at their slug there and marked as in it; the articles not translated, in the team's", async () => {
  await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await article("Setup", "Install the app.");
  at("de");
  expect(await search("Karte")).toEqual([{ slug: "abrechnung", title: "Abrechnung", snippet: "Mit Karte zahlen.", lang: "de" }]);
  expect(await search("install")).toEqual([{ slug: "setup", title: "Setup", snippet: "Install the app." }]);
  // A translated one its German doesn't match but its English does: found in the team's words, linking to its German page.
  expect(await search("card")).toEqual([{ slug: "abrechnung", title: "Billing", snippet: "Pay by card." }]);
  // At the default language's address: the team's words only.
  at(null);
  expect(await search("Karte")).toEqual([]);
  expect((await search("card")).map((result) => result.title)).toEqual(["Billing"]);
});

test("a version made from an older English is never searched: the article is found in the team's words instead", async () => {
  await article("Refunds", "Ask us for a refund.", { title: "Erstattung", slug: "erstattung", body: "Erstattung zu alten Preisen.", stale: true });
  at("de");
  expect(await search("Erstattung")).toEqual([]);
  expect(await search("refund")).toEqual([{ slug: "refunds", title: "Refunds", snippet: "Ask us for a refund." }]);
});

test("an AI answer at a language's address answers from the articles translated there, and its sources link to their pages there", async () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
  // Billing's English is the closest, but it has a German version: that's what's sent. Setup has none: its English is.
  model.embeddings.setVector("Wie zahle ich?", along(1));
  model.embeddings.setVector(articleChunkText("Billing", { heading: "", text: "Pay by card." }, []), along(0.95));
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Mit Karte zahlen." }, []), along(0.9));
  model.embeddings.setVector(articleChunkText("Setup", { heading: "", text: "Install the app." }, []), along(0.85));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await article("Setup", "Install the app.");
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "Mit Karte.", sources: ["s1", "s2"] }));
  const answer = await answerQuestion(project.id, "asker", "Wie zahle ich?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  const sent = JSON.stringify(model.requests.at(-1)!.messages);
  expect(sent).toContain("Mit Karte zahlen.");
  expect(sent).toContain("Install the app.");
  expect(sent).not.toContain("Pay by card.");
  const portal = await portalAddress(project.slug);
  expect(answer).toMatchObject({
    status: "answered",
    sources: [
      { slug: "abrechnung", title: "Abrechnung", url: `${portal}/de/docs/abrechnung` },
      { slug: "setup", title: "Setup", url: `${portal}/de/docs/setup` },
    ],
  });
});

/** The model and embeddings fakes, for AI answers. */
function withAi() {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
}

test("a translated article whose German isn't embedded yet, or isn't close enough to the question, answers from its English, rather than not at all", async () => {
  withAi();
  model.embeddings.setVector("Wie zahle ich?", along(1));
  model.embeddings.setVector(articleChunkText("Billing", { heading: "", text: "Pay by card." }, []), along(0.95));
  await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  model.reply(JSON.stringify({ answer: "By card.", sources: ["s1"] }));
  const answer = await answerQuestion(project.id, "asker", "Wie zahle ich?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain("Pay by card.");
  // Its page there is still the German one.
  expect(answer.sources).toEqual([{ slug: "billing", title: "Billing", url: `${await portalAddress(project.slug)}/de/docs/billing` }]);
});

test("the answer on the docs' search results page (askDocs) at a language's address: its sources at their pages there", async () => {
  withAi();
  model.embeddings.setVector("Wie zahle ich?", along(1));
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Mit Karte zahlen." }, []), along(0.9));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "Mit Karte.", sources: ["s1"] }));
  at("de");
  expect(await askDocs(project.slug, "Wie zahle ich?")).toMatchObject({
    status: "answered",
    sources: [{ slug: "abrechnung", title: "Abrechnung", url: `${await portalAddress(project.slug)}/de/docs/abrechnung` }],
  });
});

test("the English matching a question its German translation doesn't (not close enough): answered from the English", async () => {
  withAi();
  model.embeddings.setVector("How do I pay?", along(1));
  model.embeddings.setVector(articleChunkText("Billing", { heading: "", text: "Pay by card." }, []), along(0.9));
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Mit Karte zahlen." }, []), along(0.2));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "By card.", sources: ["s1"] }));
  const answer = await answerQuestion(project.id, "asker", "How do I pay?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  expect(answer).toMatchObject({ status: "answered", sources: [{ slug: "billing", title: "Billing" }] });
});

test("a version made from an older English never answers, even embedded: its English does", async () => {
  withAi();
  model.embeddings.setVector("Wie zahle ich?", along(1));
  model.embeddings.setVector(articleChunkText("Billing", { heading: "", text: "Pay by card." }, []), along(0.8));
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Zu alten Preisen zahlen." }, []), along(0.95));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Zu alten Preisen zahlen.", stale: true });
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "By card.", sources: ["s1"] }));
  await answerQuestion(project.id, "asker", "Wie zahle ich?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  const sent = JSON.stringify(model.requests.at(-1)!.messages);
  expect(sent).toContain("Pay by card.");
  expect(sent).not.toContain("Zu alten Preisen");
});

test("a search at a language's address is counted once in the team's insights; the box's as-you-type search isn't counted", async () => {
  await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  at("de");
  await search("Karte");
  await searchDocsAsTyped(project.slug, "Karte");
  // Counted without being waited for: there once it's written.
  await expect.poll(async () => (await prisma.docsSearchDay.findMany({ where: { projectId: project.id } })).map(({ searches, failed }) => ({ searches, failed }))).toEqual([{ searches: 1, failed: 0 }]);
  // (Nothing more is on its way.)
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await prisma.docsSearchDay.findFirstOrThrow({ where: { projectId: project.id } })).searches).toBe(1);
});

test("a version made from an older English with many close sections can't crowd out a current translation: it still answers", async () => {
  withAi();
  model.embeddings.setVector("Wie zahle ich?", along(1));
  // Refunds' outdated German: 13 sections, every one closer than Billing's German (more than the sections looked at).
  const parts = Array.from({ length: 13 }, (_, i) => [`Teil ${i + 1}`, `Alte Preise ${i + 1}.`]);
  const content: Doc = {
    type: "doc",
    content: parts.flatMap(([heading, text]) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ]),
  };
  for (const chunk of toChunks(content)) {
    model.embeddings.setVector(articleChunkText("Erstattung", chunk, []), along(0.99));
  }
  const refunds = await article("Refunds", "Ask us for a refund.", { title: "Erstattung", slug: "erstattung", body: "Alte Preise.", stale: true });
  await prisma.articleTranslation.update({ where: { id: refunds.versionId! }, data: { content } });
  await embedTranslation(refunds.versionId!, log);
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: refunds.versionId! } })).toBe(13);
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Mit Karte zahlen." }, []), along(0.9));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "Mit Karte.", sources: ["s1"] }));
  await answerQuestion(project.id, "asker", "Wie zahle ich?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  const sent = JSON.stringify(model.requests.at(-1)!.messages);
  expect(sent).toContain("Mit Karte zahlen.");
  expect(sent).not.toContain("Alte Preise");
});

test("more outdated translations than one look at holds, all closer than a current one: the current one is still found and answers", async () => {
  withAi();
  model.embeddings.setVector("Wie zahle ich?", along(1));
  for (let i = 1; i <= 13; i++) {
    model.embeddings.setVector(articleChunkText(`Alt ${i}`, { heading: "", text: `Alte Preise ${i}.` }, []), along(0.99));
    const old = await article(`Old ${i}`, `Old prices ${i}.`, { title: `Alt ${i}`, slug: `alt-${i}`, body: `Alte Preise ${i}.`, stale: true });
    await embedTranslation(old.versionId!, log);
  }
  model.embeddings.setVector(articleChunkText("Abrechnung", { heading: "", text: "Mit Karte zahlen." }, []), along(0.9));
  const billing = await article("Billing", "Pay by card.", { title: "Abrechnung", slug: "abrechnung", body: "Mit Karte zahlen." });
  await embedTranslation(billing.versionId!, log);
  model.reply(JSON.stringify({ answer: "Mit Karte.", sources: ["s1"] }));
  await answerQuestion(project.id, "asker", "Wie zahle ich?", "PORTAL", SIGNED_OUT, { language: { code: "de", prefix: "/de" } });
  const sent = JSON.stringify(model.requests.at(-1)!.messages);
  expect(sent).toContain("Mit Karte zahlen.");
  expect(sent).not.toContain("Alte Preise");
});

