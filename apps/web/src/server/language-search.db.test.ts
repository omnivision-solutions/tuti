import { prisma } from "@tuti/db";
import { embedTranslation } from "@tuti/jobs";
import { articleChunkText } from "@tuti/shared";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { portalAddress } from "./custom-domains";
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
