import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { AI_ROLE_NAMES, articleChunkText, DEFAULT_AI_MODEL } from "@tuti/shared";
import { billingFile, type ModelFake, type OpenAIFake, startModelFake } from "@tuti/testkit";
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
  model = await startModelFake();
  openai = model.embeddings;
});
afterAll(() => Promise.all([openai.close(), model.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...model.env })) {
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
  expect((await call(getAiModels, as(), {})).answers).toEqual({ model: null, default: "acme/tiny", used: "acme/tiny" });
  expect(await answeredWith(project.id)).toBe("acme/tiny");
});

test("only a model the endpoint lists can be picked; nothing is saved otherwise", async () => {
  await expect(call(updateAiModels, as(), { answers: "acme/tiny", changelog: "acme/imaginary" })).rejects.toMatchObject({
    status: 400,
    code: "unknown_model",
    message: "There's no model “acme/imaginary”",
  });
  // The endpoint's list can't be read: refused, rather than saving an id nobody checked.
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:1");
  await expect(call(updateAiModels, as(), { answers: "acme/tiny" })).rejects.toMatchObject({ status: 502, code: "models_unavailable" });
  // Going back to the default needs no list, nor does turning the double-check off.
  await call(updateAiModels, as(), { changelog: "" });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { aiModels: true } })).toEqual({ aiModels: {} });
  await call(updateAiModels, as(), { code_changes_check: "off" });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { aiModels: true } })).toEqual({ aiModels: { code_changes_check: "off" } });
});

test("under the server's cap only models priced at or under it can be picked; the default needs no check", async () => {
  vi.stubEnv("AI_MODEL_MAX_PRICE", "5");
  // Claude Haiku costs $5 per million output tokens in the fake's list, Sonnet $15.
  await call(updateAiModels, as(), { answers: "anthropic/claude-haiku-5.5" });
  await expect(call(updateAiModels, as(), { changelog: "acme/tiny", answers: "anthropic/claude-sonnet-5.5" })).rejects.toMatchObject({
    status: 400,
    code: "model_over_cap",
    message: "“anthropic/claude-sonnet-5.5” costs $15 per million output tokens; this server allows models up to $5",
  });
  await expect(call(updateAiModels, as(), { answers: "acme/no-price" })).rejects.toMatchObject({
    code: "model_over_cap",
    message: "“acme/no-price” has no price; this server allows models up to $5",
  });
  // Nothing of the refused requests was saved, not even acme/tiny, which is under the cap.
  expect((await call(getAiModels, as(), {})).changelog.model).toBeNull();
  vi.stubEnv("AI_MODEL_CHANGELOG", "anthropic/claude-sonnet-5.5");
  await call(updateAiModels, as(), { answers: "" });
  const models = await call(getAiModels, as(), {});
  expect([models.answers.model, models.changelog]).toEqual([null, { model: null, default: "anthropic/claude-sonnet-5.5", used: "anthropic/claude-sonnet-5.5" }]);
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

test("the migration: picks saved under the old names become their roles' (the Inbox's one pick both of its roles', the double-check Checks), and a role's own pick is kept", async () => {
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261117150000_ai_model_roles/migration.sql", import.meta.url), "utf8");
  await prisma.project.update({
    where: { id: project.id },
    data: { aiModels: { support: "acme/tiny", code_changes_redecide: "off", support_summary: "anthropic/claude-sonnet-5.5", answers: "acme/tiny" } },
  });
  await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('UPDATE "project"')));
  expect(await call(getAiModels, as(), {})).toMatchObject({
    support_draft: { model: "acme/tiny" },
    support_summary: { model: "anthropic/claude-sonnet-5.5" },
    code_changes_check: { model: "off" },
    answers: { model: "acme/tiny" },
  });
});

test("every role is listed with its default: the Inbox's two share the support feature's", async () => {
  vi.stubEnv("AI_MODEL_SUPPORT", "acme/tiny");
  const models = await call(getAiModels, as(), {});
  // Each role, and the groups' levels beside them.
  expect(Object.keys(models).sort()).toEqual([...AI_ROLE_NAMES, "levels"].sort());
  expect(models).toMatchObject({ support_draft: { model: null, default: "acme/tiny" }, support_summary: { model: null, default: "acme/tiny" } });
  expect((await call(updateAiModels, as(), { support_summary: "anthropic/claude-sonnet-5.5" })).support_draft.model).toBeNull();
});

test("Autopilot's roles: Decides and Checks have their own picks (Off only for Checks); each role takes only models with tool calls", async () => {
  expect(await call(getAiModels, as(), {})).toMatchObject({
    code_changes_decide: { model: null, default: "anthropic/claude-haiku-5.5" },
    code_changes_check: { model: null, default: "anthropic/claude-sonnet-5.5" },
  });
  expect(await call(updateAiModels, as(), { code_changes_decide: "acme/tiny", code_changes_check: "off" })).toMatchObject({
    code_changes_decide: { model: "acme/tiny" },
    code_changes_check: { model: "off" },
  });
  await expect(call(updateAiModels, as(), { code_changes_decide: "off" })).rejects.toMatchObject({ status: 400, message: "Only Autopilot's checks can be off" });
  for (const pick of ["code_changes_decide", "code_changes_check", "code_changes"]) {
    await expect(call(updateAiModels, as(), { [pick]: "acme/no-tools" })).rejects.toMatchObject({
      status: 400,
      code: "model_without_tools",
      message: "“acme/no-tools” can't call tools, which Autopilot's docs agent needs",
    });
  }
  // Other features take it.
  expect((await call(updateAiModels, as(), { answers: "acme/no-tools" })).answers.model).toBe("acme/no-tools");
  // The form sends the steps too.
  actAs(owner);
  const form = new FormData();
  form.set("code_changes_check", "");
  expect(await saveAiModels(project.slug, {}, form)).toEqual({});
  expect((await call(getAiModels, as(), {})).code_changes_check.model).toBeNull();
});

const onPlan = (plan: string) => prisma.project.update({ where: { id: project.id }, data: { plan } });

test("levels: a group runs on its level's models; a plan picks levels with aiLevels and models with Custom's feature, and a level it loses is kept and not used", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const SONNET = "anthropic/claude-sonnet-5.5";

  // The free plan runs on Balanced: no level, no model of its own. Autopilot's checks can still be switched off.
  await onPlan("free");
  await expect(call(updateAiModels, as(), { levels: { answers: "best" } })).rejects.toMatchObject({ status: 402, code: "plan_required", message: "Choosing an AI level needs the Pro plan. See Settings → Billing." });
  await expect(call(updateAiModels, as(), { answers: SONNET })).rejects.toMatchObject({ status: 402, code: "plan_required", message: "Picking your own AI models needs the Business plan. See Settings → Billing." });
  // Not even with a level the plan has sent beside it.
  await expect(call(updateAiModels, as(), { answers: SONNET, levels: { answers: "balanced" } })).rejects.toMatchObject({ status: 402, code: "plan_required" });
  expect((await call(getAiModels, as(), {})).answers.model).toBeNull();
  expect(await call(updateAiModels, as(), { code_changes_check: "off", answers: "" })).toMatchObject({ code_changes_check: { model: "off", used: "off" }, levels: { code_changes: { level: "balanced" } } });

  // Pro picks a level, not its own models.
  await onPlan("pro");
  expect(await call(updateAiModels, as(), { levels: { answers: "best" } })).toMatchObject({
    answers: { model: null, default: DEFAULT_AI_MODEL, used: SONNET },
    changelog: { used: DEFAULT_AI_MODEL },
    levels: { answers: { level: "best", used: "best", available: ["affordable", "balanced", "best"] }, changelog: { level: "balanced" } },
  });
  expect(await answeredWith(project.id)).toBe(SONNET);
  await expect(call(updateAiModels, as(), { levels: { answers: "custom" } })).rejects.toMatchObject({ status: 402 });

  // Business picks models: a pick puts its group on Custom.
  await onPlan("business");
  expect(await call(updateAiModels, as(), { answers: "acme/tiny" })).toMatchObject({ answers: { model: "acme/tiny", used: "acme/tiny" }, levels: { answers: { level: "custom", used: "custom" } } });
  expect(await answeredWith(project.id)).toBe("acme/tiny");

  // Back on Free, the pick and the level are kept and the work runs on Balanced.
  await onPlan("free");
  expect(await call(getAiModels, as(), {})).toMatchObject({ answers: { model: "acme/tiny", used: DEFAULT_AI_MODEL }, levels: { answers: { level: "custom", used: "balanced", available: ["balanced"] } } });
  expect(await answeredWith(project.id)).toBe(DEFAULT_AI_MODEL);
});

test("levels: one the server doesn't offer, or whose models cost more than its cap, can't be saved", async () => {
  vi.stubEnv("AI_MODEL_MAX_PRICE", "5");
  // Best's row is Sonnet, $15 per million output tokens in the fake's list; Affordable's is Haiku, $5.
  await expect(call(updateAiModels, as(), { levels: { answers: "best" } })).rejects.toMatchObject({ status: 400, code: "level_unavailable", message: "The best level uses “anthropic/claude-sonnet-5.5”, which costs more than this server allows" });
  expect((await call(getAiModels, as(), {})).levels.answers.available).toEqual(["affordable", "balanced", "custom"]);
  expect((await call(updateAiModels, as(), { levels: { answers: "affordable" } })).levels.answers.level).toBe("affordable");
  // A server that set its own models and has no levels file has only Balanced and Custom.
  vi.stubEnv("AI_MODEL", "acme/tiny");
  await expect(call(updateAiModels, as(), { levels: { support: "affordable" } })).rejects.toMatchObject({ status: 400, code: "level_unavailable", message: "This server doesn't offer the affordable level" });
  expect((await call(getAiModels, as(), {})).levels.answers).toEqual({ level: "affordable", used: "balanced", available: ["balanced", "custom"] });
});

test("a model picked before levels, or through the release before them, keeps being used: its group counts as Custom until a level is saved", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { aiModels: { answers: "acme/tiny", code_changes_check: "off" } } });
  expect(await call(getAiModels, as(), {})).toMatchObject({
    answers: { used: "acme/tiny" },
    levels: { answers: { level: "custom", used: "custom" }, code_changes: { level: "balanced" } },
  });
  expect(await answeredWith(project.id)).toBe("acme/tiny");
  // Balanced is saved, so the pick is kept and no longer used.
  expect(await call(updateAiModels, as(), { levels: { answers: "balanced" } })).toMatchObject({ answers: { model: "acme/tiny", used: DEFAULT_AI_MODEL }, levels: { answers: { level: "balanced" } } });
});
