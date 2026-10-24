import { prisma } from "@tuti/db";
import { articleChunkText, DEFAULT_AI_MODEL } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { saveAiModels } from "@/server/ai-models";
import { getAiModels, updateAiModels } from "@/server/operations/ai-models";
import { answerQuestion } from "@/server/operations/docs-ask";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Models per feature (docs/plan.md, AI usage per project): the server's default for each feature, or the project's pick. */

let openai: OpenAIFake;
let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [openai, model] = await Promise.all([startOpenAIFake(), startModelFake()]);
});
afterAll(() => Promise.all([openai.close(), model.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

const QUESTION = "How do I add a colleague?";
const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });

/** Asks QUESTION in `projectId`, which has an article close to it, and says which model answered. */
async function answeredWith(projectId: string) {
  openai.setVector(QUESTION, [1, 0]);
  openai.setVector(articleChunkText("Inviting your team", { heading: "", text: "Invite people from the Team page." }), [1, 0]);
  if (!(await prisma.article.findFirst({ where: { projectId } }))) {
    const article = await call(createArticle, as(projectId), { title: "Inviting your team", body: "Invite people from the Team page." });
    await call(publishArticle, as(projectId), { slug: article.slug });
  }
  model.reply(JSON.stringify({ answer: "From the Team page.", sources: ["s1"] }));
  expect((await answerQuestion(projectId, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).status).toBe("answered");
  return model.requests.at(-1)!.model;
}

test("each feature uses the server's default for it, unless the project picked another; empty goes back to the default", async () => {
  expect(await answeredWith(project.id)).toBe(DEFAULT_AI_MODEL);
  vi.stubEnv("AI_MODEL_ANSWERS", "acme/tiny");
  expect(await answeredWith(project.id)).toBe("acme/tiny");

  const other = await createProject(owner);
  expect(await call(updateAiModels, as(), { answers: "anthropic/claude-sonnet-5.5" })).toMatchObject({
    answers: { model: "anthropic/claude-sonnet-5.5", default: "acme/tiny" },
    changelog: { model: null, default: DEFAULT_AI_MODEL },
  });
  expect(await answeredWith(project.id)).toBe("anthropic/claude-sonnet-5.5");
  // Only this project's.
  expect(await answeredWith(other.id)).toBe("acme/tiny");

  await call(updateAiModels, as(), { answers: "" });
  expect((await call(getAiModels, as(), {})).answers).toEqual({ model: null, default: "acme/tiny" });
  expect(await answeredWith(project.id)).toBe("acme/tiny");
});

test("only a model the endpoint lists can be picked; nothing is saved otherwise", async () => {
  await expect(call(updateAiModels, as(), { answers: "acme/tiny", changelog: "acme/imaginary" })).rejects.toMatchObject({
    status: 400,
    code: "unknown_model",
    message: "127.0.0.1 has no model “acme/imaginary”",
  });
  // The endpoint's list can't be read: refused, rather than saving an id nobody checked.
  vi.stubEnv("OPENROUTER_BASE_URL", "http://127.0.0.1:1");
  await expect(call(updateAiModels, as(), { answers: "acme/tiny" })).rejects.toMatchObject({ status: 502, code: "models_unavailable" });
  // Going back to the default needs no list.
  await call(updateAiModels, as(), { changelog: "" });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { aiModels: true } })).toEqual({ aiModels: {} });
});

test("two people picking models for different features at once both keep theirs", async () => {
  await Promise.all([call(updateAiModels, as(), { answers: "acme/tiny" }), call(updateAiModels, as(), { changelog: "anthropic/claude-sonnet-5.5" })]);
  const models = await call(getAiModels, as(), {});
  expect([models.answers.model, models.changelog.model, models.escalations.model]).toEqual(["acme/tiny", "anthropic/claude-sonnet-5.5", null]);
});

test("the settings form saves only what it sends: a feature it leaves out keeps its model", async () => {
  await call(updateAiModels, as(), { answers: "acme/tiny" });
  actAs(owner);
  const form = new FormData();
  form.set("changelog", "anthropic/claude-sonnet-5.5");
  expect(await saveAiModels(project.slug, {}, form)).toEqual({});
  const models = await call(getAiModels, as(), {});
  expect([models.answers.model, models.changelog.model]).toEqual(["acme/tiny", "anthropic/claude-sonnet-5.5"]);
});
