import { prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { creditsOn, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { getAiFirst, updateAiFirst } from "./ai-first";
import { createArticle, publishArticle } from "./docs";
import { call } from "./run";

/** "AI answers first"'s settings (docs/plan.md, Inbox automation, W14): the switches, the name, and what keeps it off. */

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => Promise.all([model.embeddings.close(), model.close()]));
beforeEach(() => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const owner = await signUp();
  const project = await createProject(owner);
  return { projectId: project.id, admin: { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id } };
}

async function publish(admin: Awaited<ReturnType<typeof setup>>["admin"], body = "Settings → Export downloads everything as CSV.") {
  const article = await call(createArticle, admin, { title: "Exporting", body });
  await call(publishArticle, admin, { slug: article.slug });
  return article;
}

test("on for the widget and off for email to start, with no name; each field changes alone", async () => {
  const { admin } = await setup();
  await publish(admin);
  expect(await call(getAiFirst, admin, {})).toEqual({ widget: true, email: false, name: null, offFor: [] });
  expect(await call(updateAiFirst, admin, { email: true })).toEqual({ widget: true, email: true, name: null, offFor: [] });
  expect(await call(updateAiFirst, admin, { widget: false, name: "  Ada " })).toEqual({ widget: false, email: true, name: "Ada", offFor: [] });
  // Empty clears it, as null does.
  expect(await call(updateAiFirst, admin, { name: "" })).toMatchObject({ name: null, widget: false, email: true });
  await expect(call(updateAiFirst, admin, { name: "x".repeat(51) })).rejects.toThrow("Keep the name under 50 characters");
});

test("no published articles: the AI is off for it, and a sample, hidden or unpublished article doesn't count", async () => {
  const { projectId, admin } = await setup();
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["no_articles"]);
  const draft = await call(createArticle, admin, { title: "Draft", body: "Not yet." });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["no_articles"]);
  await call(publishArticle, admin, { slug: draft.slug });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual([]);
  await prisma.article.updateMany({ where: { slug: draft.slug, projectId }, data: { sample: true } });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["no_articles"]);
  await prisma.article.updateMany({ where: { slug: draft.slug, projectId }, data: { sample: false, listing: "HIDDEN" } });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["no_articles"]);
});

test("out of AI credits: off for it until credits come", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  const { projectId, admin } = await setup();
  await publish(admin);
  await grantCredits(projectId, "MANUAL", 100, { days: null });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual([]);
  await prisma.creditGrant.deleteMany({ where: { projectId } });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["out_of_credits"]);
  // Both at once.
  await prisma.article.updateMany({ where: { projectId }, data: { publishedAt: null } });
  expect((await call(getAiFirst, admin, {})).offFor).toEqual(["no_articles", "out_of_credits"]);
});

test("a server without AI answers: off for that alone, the switches kept as set", async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("OPENAI_API_KEY", "");
  const { admin } = await setup();
  expect(await call(updateAiFirst, admin, { email: true })).toEqual({ widget: true, email: true, name: null, offFor: ["no_ai_answers"] });
});
