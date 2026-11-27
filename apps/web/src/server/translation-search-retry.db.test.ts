import { type Doc, toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers, languageTranslationsDone, sourceSections, translationSource } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, publishArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";
import { getTranslation, publishTranslation, saveTranslation } from "./operations/translations";

/**
 * A server with embeddings but no chat model (the embeddings-only setup): the versions the team writes still get their search
 * data, the retry job bringing back one whose embedding failed. Chat is turned off here by `aiEnabled` (embeddings-only
 * proper sends embeddings to OpenAI's own address, which tests never reach); embeddings go to the local fake.
 */
const chat = vi.hoisted(() => ({ on: true }));
vi.mock("@tuti/shared", async (original) => ({ ...(await original<typeof import("@tuti/shared")>()), aiEnabled: () => chat.on }));

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
  chat.on = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const log = { info: () => {}, warn: () => {} };
const de = { slug: "billing", language: "de" as const };
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("with chat off, a version the team writes whose embedding failed on publishing is embedded by the retry job", async () => {
  await call(updateLanguages, as(), { languages: [{ code: "de", newPages: "manual" }] });
  await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
  await call(publishArticle, as(), { slug: "billing" });
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id } });
  const sections = sourceSections(translationSource(article).text).map(({ key, hash }) => ({ key, hash }));
  const content: Doc = { type: "doc", content: [paragraph("Mit Karte zahlen.")] };
  await prisma.articleTranslation.create({ data: { articleId: article.id, projectId: project.id, language: "de", automatic: false, title: "Abrechnung", content, body: toPlainText(content), sections, publishedAt: new Date() } });
  chat.on = false;
  // The team publishes an edit; the embeddings provider fails then.
  const read = await call(getTranslation, as(), de);
  await call(saveTranslation, as(), { ...de, content: { type: "doc", content: [paragraph("Per Karte zahlen.")] }, version: read.version });
  model.embeddings.failNext(500);
  await call(publishTranslation, as(), de);
  const waiting = await prisma.articleTranslation.findFirstOrThrow({ where: { articleId: article.id } });
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: waiting.id } })).toBe(0);
  // Due: the retry job queues it though chat is off, and it's embedded (no model asked).
  await prisma.articleTranslation.update({ where: { id: waiting.id }, data: { retryAt: new Date(Date.now() - 1000) } });
  expect(await handlers.retryArticleTranslations({}, log)).toMatchObject({ queued: 1 });
  await languageTranslationsDone();
  expect(await prisma.articleTranslationChunk.count({ where: { translationId: waiting.id } })).toBeGreaterThan(0);
  expect(model.requests).toHaveLength(0);
});
