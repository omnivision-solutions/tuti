import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prisma } from "@tuti/db";
import { AI_ROLE_NAMES, articleChunkText, DEFAULT_AI_MODEL, resetCodeChangesSettings } from "@tuti/shared";
import { billingFile, type ModelFake, type OpenAIFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { aiModelSetting, checksNotice, checksSwitch } from "@/lib/ai-model-setting";
import { saveAiModel } from "@/server/ai-models";
import { getAiModels, updateAiModels } from "@/server/operations/ai-models";
import { answerQuestion } from "@/server/operations/docs-ask";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

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
  // A test that set Autopilot's variables: the next one reads the server's own again.
  resetCodeChangesSettings();
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
  expect(await saveAiModel(project.slug, { changelog: "anthropic/claude-sonnet-5.5" })).toEqual({});
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
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
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

test("a settings page's AI model: every level the server offers, with the upgrade prompt on those the plan lacks; the models in use by name; a saved level that isn't used is said; it saves a level or a pick", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_fake");
  actAs(owner);
  const setting = async () => aiModelSetting(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }), "answers", { answers: "Answers", escalations: "Summaries" });
  const billingHref = `/app/${project.slug}/settings/billing`;
  const levels = { title: "Choosing an AI level needs the Pro plan.", billingHref, note: null };
  const custom = { title: "Picking your own AI models needs the Business plan.", billingHref, note: null };

  // Free: every level is there, and all but Balanced open the prompt. The server refuses them too.
  await onPlan("free");
  const free = await setting();
  expect(free).toMatchObject({ projectSlug: project.slug, group: "answers", saved: "balanced", used: "balanced", notice: null });
  expect(free.levels).toEqual([
    { level: "affordable", name: "Affordable", upgrade: levels },
    { level: "balanced", name: "Balanced", upgrade: null },
    { level: "best", name: "Best", upgrade: levels },
    { level: "custom", name: "Custom", upgrade: custom },
  ]);
  expect(await saveAiModel(project.slug, { levels: { answers: "best" } })).toEqual({ error: "Choosing an AI level needs the Pro plan. See Settings → Billing." });

  // Pro: Best saves, and the summary names its model as the endpoint does, without the provider.
  await onPlan("pro");
  expect(await saveAiModel(project.slug, { levels: { answers: "best" } })).toEqual({});
  const pro = await setting();
  expect(pro).toMatchObject({ saved: "best", used: "best", summary: "Answers Claude Sonnet 5.5 · Summaries Claude Sonnet 5.5", notice: null });
  expect(pro.levels.map(({ level, upgrade }) => [level, upgrade?.title ?? null])).toEqual([["affordable", null], ["balanced", null], ["best", null], ["custom", custom.title]]);

  // Business: Custom, and a pick for one role; the other runs on the server's own. Only models under the server's cap are offered.
  await onPlan("business");
  vi.stubEnv("AI_MODEL_MAX_PRICE", "15");
  expect(await saveAiModel(project.slug, { levels: { answers: "custom" } })).toEqual({});
  expect(await saveAiModel(project.slug, { escalations: "acme/tiny" })).toEqual({});
  const business = await setting();
  expect(business).toMatchObject({ saved: "custom", used: "custom", notice: null });
  expect(business.summary).toMatch(/^Answers .+ · Summaries Tiny$/);
  expect(business.roles).toEqual([
    { role: "answers", label: "Answers", model: "", default: DEFAULT_AI_MODEL, used: DEFAULT_AI_MODEL, agent: false },
    { role: "escalations", label: "Summaries", model: "acme/tiny", default: DEFAULT_AI_MODEL, used: "acme/tiny", agent: false },
  ]);
  expect(business.listed.map((listed) => listed.id)).not.toContain("acme/no-price");
  expect(business.levels.every((level) => level.upgrade === null)).toBe(true);

  // Back on Free: Custom is kept and not used, so Balanced is the one shown, with a line saying so.
  await onPlan("free");
  expect(await setting()).toMatchObject({ saved: "custom", used: "balanced", notice: "Custom isn't available on this plan." });

  // A level the server's cap rules out isn't offered as an upgrade: no plan would bring it.
  vi.stubEnv("AI_MODEL_MAX_PRICE", "5");
  await prisma.project.update({ where: { id: project.id }, data: { aiLevels: { answers: "best" } } });
  const capped = await setting();
  expect(capped.levels.map(({ level }) => level)).toEqual(["affordable", "balanced", "custom"]);
  expect(capped).toMatchObject({ saved: "best", used: "balanced", notice: "Best isn't available on this server." });
});

test("a settings page's AI model on a server without plans: no prompts; a level over the server's cap isn't shown, and a saved one the server stopped offering is said", async () => {
  vi.stubEnv("AI_MODEL_MAX_PRICE", "5");
  const setting = async () => aiModelSetting(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }), "changelog", { changelog: "Drafts" });
  expect((await setting()).levels).toEqual([
    { level: "affordable", name: "Affordable", upgrade: null },
    { level: "balanced", name: "Balanced", upgrade: null },
    { level: "custom", name: "Custom", upgrade: null },
  ]);
  await call(updateAiModels, as(), { levels: { changelog: "affordable" } });
  expect(await setting()).toMatchObject({ used: "affordable", summary: "Drafts Claude Haiku 5.5" });
  vi.stubEnv("AI_MODEL", "acme/tiny");
  const own = await setting();
  expect(own).toMatchObject({ saved: "affordable", used: "balanced", summary: "Drafts Tiny", notice: "Affordable isn't available on this server." });
  expect(own.levels.map(({ level }) => level)).toEqual(["balanced", "custom"]);
});

test("Autopilot's Checks switch: off needs no plan and holds on every level and under Custom, and the AI model setting says so; on goes back to the level's model, or the server's under Custom; a member can't flip it", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const HAIKU = "anthropic/claude-haiku-5.5";
  const SONNET = "anthropic/claude-sonnet-5.5";
  /** What Settings → Autopilot shows: the line under AI model, Custom's row for Checks, and the model the checks run on. */
  const shown = async () => {
    const setting = await aiModelSetting(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }), "code_changes", { code_changes_decide: "Decides", code_changes_check: "Checks", code_changes: "Writes" });
    // The switch is on exactly when the line above it names a model for Checks.
    expect(checksSwitch(setting)).toMatchObject({ on: !setting.summary.includes("Checks Off") });
    return { summary: setting.summary, used: setting.used, checks: setting.roles[1]!.model, runsOn: (await call(getAiModels, as(), {})).code_changes_check.used };
  };
  actAs(owner);

  // Free, on Balanced: on by default, on the server's model for it. Off is the switch's save, and needs no plan.
  await onPlan("free");
  expect(await shown()).toEqual({ summary: "Decides Claude Haiku 5.5 · Checks Claude Sonnet 5.5 · Writes Claude Sonnet 5.5", used: "balanced", checks: "", runsOn: SONNET });
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({});
  expect(await shown()).toEqual({ summary: "Decides Claude Haiku 5.5 · Checks Off · Writes Claude Sonnet 5.5", used: "balanced", checks: "off", runsOn: "off" });
  // On again: the pick is cleared, so it's the level's model.
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
  expect(await shown()).toMatchObject({ checks: "", runsOn: SONNET });

  // With a level: off holds whatever level is chosen after it, the other roles follow the level, and on is that level's model.
  await onPlan("pro");
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({});
  expect(await saveAiModel(project.slug, { levels: { code_changes: "affordable" } })).toEqual({});
  expect(await shown()).toEqual({ summary: "Decides Claude Haiku 5.5 · Checks Off · Writes Claude Haiku 5.5", used: "affordable", checks: "off", runsOn: "off" });
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
  expect(await shown()).toMatchObject({ summary: "Decides Claude Haiku 5.5 · Checks Claude Haiku 5.5 · Writes Claude Haiku 5.5", used: "affordable", runsOn: HAIKU });

  // With Custom: off doesn't move the group off Custom or touch the other roles' picks; on, Checks runs on the server's own until a model is picked.
  await onPlan("business");
  expect(await saveAiModel(project.slug, { code_changes_decide: "acme/tiny", code_changes_check: "acme/tiny" })).toEqual({});
  expect(await shown()).toMatchObject({ used: "custom", checks: "acme/tiny", runsOn: "acme/tiny" });
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({});
  expect(await shown()).toEqual({ summary: "Decides Tiny · Checks Off · Writes Claude Sonnet 5.5", used: "custom", checks: "off", runsOn: "off" });
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
  expect(await shown()).toEqual({ summary: "Decides Tiny · Checks Claude Sonnet 5.5 · Writes Claude Sonnet 5.5", used: "custom", checks: "", runsOn: SONNET });

  // Off under Custom, then a plan without Custom: still off, on Balanced.
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({});
  await onPlan("free");
  expect(await shown()).toMatchObject({ summary: "Decides Claude Haiku 5.5 · Checks Off · Writes Claude Sonnet 5.5", used: "balanced", runsOn: "off" });

  // Admins flip it, like the AI model; other team members can't.
  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({ error: "Only project owners and admins can change AI models" });
  expect((await call(getAiModels, as(), {})).code_changes_check).toMatchObject({ model: null, used: SONNET });
});

test("the Checks switch on a server whose own checks are off: none where they wouldn't run anyway; where the level in use has a model for them it's there, on, and switches them off and on", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tuti-levels-")), "levels.json");
  writeFileSync(path, JSON.stringify({ best: { code_changes_check: "anthropic/claude-sonnet-5.5" } }));
  vi.stubEnv("AI_LEVELS_CONFIG", path);
  vi.stubEnv("CODE_CHANGES_REDECIDE_MODEL", "off");
  resetCodeChangesSettings();
  const setting = async () => aiModelSetting(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }), "code_changes", { code_changes_decide: "Decides", code_changes_check: "Checks", code_changes: "Writes" });
  actAs(owner);

  // Balanced is the server's own: no checks, said in the line, and no switch that could only claim otherwise.
  const balanced = await setting();
  expect(balanced.summary).toContain("Checks Off");
  expect(checksSwitch(balanced)).toBeNull();
  // Where the server checks the project's edits, the notice that they wait still shows, offering no switch.
  const autopilot = { plan: null, analyseCodeChanges: true, autopilotArticleEdits: true, autopilotChecksNoticeDismissed: false };
  expect(checksNotice(project.slug, balanced, autopilot)).toBeNull();
  vi.stubEnv("AUTOPILOT_CHECKS_PROJECTS", project.slug);
  expect(checksNotice(project.slug, balanced, autopilot)).toEqual({ switchable: false });

  // Best has a model for them: they run, so the switch is there and on; off holds, and on is Best's model again.
  expect(await saveAiModel(project.slug, { levels: { code_changes: "best" } })).toEqual({});
  const best = await setting();
  expect(best.summary).toContain("Checks Claude Sonnet 5.5");
  expect(checksSwitch(best)).toEqual({ on: true, model: "anthropic/claude-sonnet-5.5" });
  // On Best they run: no notice while Checks is on.
  expect(checksNotice(project.slug, best, autopilot)).toBeNull();
  expect(await saveAiModel(project.slug, { code_changes_check: "off" })).toEqual({});
  // Off, the switch still knows what they'd run on, so the page can price them.
  expect(checksSwitch(await setting())).toEqual({ on: false, model: "anthropic/claude-sonnet-5.5" });
  // Off with a switch to offer: the notice can switch Checks on.
  expect(checksNotice(project.slug, await setting(), autopilot)).toEqual({ switchable: true });
  expect(await saveAiModel(project.slug, { code_changes_check: "" })).toEqual({});
  expect(checksSwitch(await setting())).toEqual({ on: true, model: "anthropic/claude-sonnet-5.5" });

  // Off saved, then back on Balanced, where on would run nothing either: no switch that could say "on" while they're off.
  expect(await saveAiModel(project.slug, { code_changes_check: "off", levels: { code_changes: "balanced" } })).toEqual({});
  expect(checksSwitch(await setting())).toBeNull();

  // Custom with a model picked for Checks: on, whatever the server's own is.
  expect(await saveAiModel(project.slug, { code_changes_check: "acme/tiny" })).toEqual({});
  expect(checksSwitch(await setting())).toEqual({ on: true, model: "acme/tiny" });
});
