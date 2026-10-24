import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { answerQuestion } from "@/server/operations/docs-ask";
import { createArticle, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { getUsage } from "@/server/operations/usage";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** AI usage per project (docs/plan.md): every answered AI request is recorded for its project, for billing. */

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
  vi.restoreAllMocks();
  model.done();
});

const QUESTION = "How do I add a colleague?";
const TITLE = "Inviting your team";
const TEXT = "Owners and admins invite people from the Team page.";
const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });

/** A published article close to QUESTION, and the model's answer from it. */
async function answerable(projectId = project.id) {
  openai.setVector(QUESTION, [1, 0]);
  openai.setVector(articleChunkText(TITLE, { heading: "", text: TEXT }), [1, 0]);
  const article = await call(createArticle, as(projectId), { title: TITLE, body: TEXT });
  await call(publishArticle, as(projectId), { slug: article.slug });
  model.reply(JSON.stringify({ answer: "From the Team page.", sources: ["s1"] }));
}

const usage = (projectId = project.id) =>
  prisma.aiUsage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { feature: true, kind: true, model: true, inputTokens: true, outputTokens: true, cost: true },
  });

test("every answered request is recorded for its project: the feature, the model, tokens and cost", async () => {
  await answerable();
  expect((await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).status).toBe("answered");
  // Publishing indexed the article and the question was embedded, but embeddings aren't recorded (they cost less than the rows): only the model's answer is.
  expect(openai.inputs).toContain(QUESTION);
  const rows = await usage();
  expect(rows.map(({ feature, kind }) => `${feature} ${kind}`)).toEqual(["answers chat"]);
  // The model fake's usage: a token per character, a millionth of a dollar each.
  const chat = rows[0]!;
  expect(chat.inputTokens).toBe(model.requests.at(-1)!.system.length + model.requests.at(-1)!.user.length);
  expect(chat.outputTokens).toBe(JSON.stringify({ answer: "From the Team page.", sources: ["s1"] }).length);
  expect(Number(chat.cost)).toBeCloseTo((chat.inputTokens + chat.outputTokens) / 1e6, 12);
});

test("usage.get sums each month by feature, newest first, for this project only; unpriced requests are counted", async () => {
  const other = await createProject(owner);
  const at = (iso: string) => new Date(iso);
  const thisMonth = new Date();
  const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 15));
  const row = (projectId: string, feature: string, cost: number | null, createdAt: Date) =>
    ({ projectId, feature, kind: "chat", model: "m", inputTokens: 100, outputTokens: 10, cost, createdAt }) as const;
  await prisma.aiUsage.createMany({
    data: [
      row(project.id, "answers", 0.002, thisMonth),
      row(project.id, "answers", 0.001, thisMonth),
      row(project.id, "code_changes", 0.01, thisMonth),
      row(project.id, "changelog", null, thisMonth),
      row(project.id, "answers", 0.5, lastMonth),
      // Another project's, and this project's from two years ago: neither counted.
      row(other.id, "answers", 9, thisMonth),
      row(project.id, "answers", 9, at("2024-01-15T00:00:00Z")),
    ],
  });
  const month = (date: Date) => date.toISOString().slice(0, 7);
  const { months } = await call(getUsage, as(), { months: 12 });
  expect(months).toEqual([
    {
      month: month(thisMonth),
      requests: 4,
      inputTokens: 400,
      outputTokens: 40,
      cost: expect.closeTo(0.013, 10) as number,
      unpriced: 1,
      features: [
        { feature: "code_changes", requests: 1, inputTokens: 100, outputTokens: 10, cost: expect.closeTo(0.01, 10) as number, unpriced: 0 },
        { feature: "answers", requests: 2, inputTokens: 200, outputTokens: 20, cost: expect.closeTo(0.003, 10) as number, unpriced: 0 },
        { feature: "changelog", requests: 1, inputTokens: 100, outputTokens: 10, cost: 0, unpriced: 1 },
      ],
    },
    {
      month: month(lastMonth),
      requests: 1,
      inputTokens: 100,
      outputTokens: 10,
      cost: expect.closeTo(0.5, 10) as number,
      unpriced: 0,
      features: [{ feature: "answers", requests: 1, inputTokens: 100, outputTokens: 10, cost: expect.closeTo(0.5, 10) as number, unpriced: 0 }],
    },
  ]);
  expect((await call(getUsage, as(), { months: 1 })).months.map((m) => m.month)).toEqual([month(thisMonth)]);
});

test("a recording that fails doesn't fail the feature", async () => {
  await answerable();
  vi.spyOn(prisma.aiUsage, "create").mockRejectedValue(new Error("database blip"));
  expect((await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).status).toBe("answered");
});

test("a project's usage goes with it", async () => {
  await answerable();
  await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {});
  await prisma.project.delete({ where: { id: project.id } });
  expect(await usage()).toEqual([]);
});
