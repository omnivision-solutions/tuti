import { prisma } from "@tuti/db";
import { aiFor, grantCredits, OutOfCredits } from "@tuti/jobs";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { createChangelogEntry, draftChangelogEntry, rewriteChangelogEntry } from "@/server/operations/changelog";
import { answerQuestion } from "@/server/operations/docs-ask";
import { getDocsInsights } from "@/server/operations/docs-insights";
import { createArticle, publishArticle, unpublishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Out of AI credits (docs/plan.md, AI usage per project): each feature pauses its own way, without asking the AI. */

let openai: OpenAIFake;
let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [openai, model] = await Promise.all([startOpenAIFake(), startModelFake()]);
});
afterAll(() => Promise.all([openai.close(), model.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url, AI_CREDITS: "on" })) {
    vi.stubEnv(name, value);
  }
  model.requests.length = 0;
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  // Nothing asked the model unscripted.
  model.done();
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const QUESTION = "How do I add a colleague?";
const TITLE = "Inviting your team";
const TEXT = "Owners and admins invite people from the Team page.";

test("the AI is paused at 0 credits or below, only with credits on", async () => {
  await expect(aiFor(project.id, "answers")).rejects.toBeInstanceOf(OutOfCredits);
  await grantCredits(project.id, "MANUAL", 1, { days: null });
  await expect(aiFor(project.id, "answers")).resolves.toMatchObject({ model: expect.any(String) as string });
  vi.stubEnv("AI_CREDITS", "");
  await prisma.aiCreditGrant.deleteMany({ where: { projectId: project.id } });
  await expect(aiFor(project.id, "answers")).resolves.toMatchObject({ model: expect.any(String) as string });
});

test("AI answers: “unavailable” with the closest articles, without asking the AI; logged as failed for want of credits, not a gap", async () => {
  openai.setVector(QUESTION, [1, 0]);
  openai.setVector(articleChunkText(TITLE, { heading: "", text: TEXT }), [1, 0]);
  const article = await call(createArticle, team(), { title: TITLE, body: TEXT });
  await call(publishArticle, team(), { slug: article.slug });

  const answer = await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {});
  expect(answer).toMatchObject({ status: "unavailable", answer: null, sources: [expect.objectContaining({ title: TITLE })] });
  expect(model.requests).toEqual([]);
  expect(await prisma.docsQuestion.findUniqueOrThrow({ where: { id: answer.id }, select: { status: true, cause: true } })).toEqual({
    status: "FAILED",
    cause: "NO_CREDITS",
  });
  expect((await call(getDocsInsights, team(), {})).gaps).toEqual([]);

  // With credits, it answers again.
  await grantCredits(project.id, "TOPUP", 10, { days: 365 });
  model.reply(JSON.stringify({ answer: "From the Team page.", sources: ["s1"] }));
  expect((await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).status).toBe("answered");
});

test("an article unpublished while the credits are checked isn't offered instead", async () => {
  openai.setVector(QUESTION, [1, 0]);
  openai.setVector(articleChunkText(TITLE, { heading: "", text: TEXT }), [1, 0]);
  const article = await call(createArticle, team(), { title: TITLE, body: TEXT });
  await call(publishArticle, team(), { slug: article.slug });
  // The sections are found, then the article is taken down while the balance is read.
  const findGrants = prisma.aiCreditGrant.findMany.bind(prisma.aiCreditGrant);
  vi.spyOn(prisma.aiCreditGrant, "findMany").mockImplementationOnce((async (args: Parameters<typeof findGrants>[0]) => {
    await call(unpublishArticle, team(), { slug: article.slug });
    return findGrants(args);
  }) as unknown as typeof prisma.aiCreditGrant.findMany);
  expect(await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).toMatchObject({ status: "unavailable", sources: [] });
  vi.restoreAllMocks();
});

test("a credit check that fails otherwise (the database) is a failed answer, with the closest articles", async () => {
  openai.setVector(QUESTION, [1, 0]);
  openai.setVector(articleChunkText(TITLE, { heading: "", text: TEXT }), [1, 0]);
  const article = await call(createArticle, team(), { title: TITLE, body: TEXT });
  await call(publishArticle, team(), { slug: article.slug });
  vi.spyOn(prisma.aiCreditGrant, "findMany").mockRejectedValueOnce(new Error("database blip"));
  expect(await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", SIGNED_OUT, {})).toMatchObject({
    status: "failed",
    sources: [expect.objectContaining({ title: TITLE })],
  });
  vi.restoreAllMocks();
  expect(model.requests).toEqual([]);
});

test("Draft with AI and Edit with AI are refused (402) with the reason, without asking the AI", async () => {
  const entry = await call(createChangelogEntry, team(), { title: "Next release", body: "Dark mode is here." });
  const refused = { status: 402, code: "no_credits", message: "This project is out of AI credits. See Settings → Billing." };
  await expect(call(draftChangelogEntry, team(), { number: entry.number })).rejects.toMatchObject(refused);
  await expect(call(rewriteChangelogEntry, team(), { number: entry.number, mode: "shorten" })).rejects.toMatchObject(refused);
  expect(model.requests).toEqual([]);
  // Not counted against the hour's AI edits either.
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { changelogAiCount: true } })).toEqual({ changelogAiCount: 0 });
});
