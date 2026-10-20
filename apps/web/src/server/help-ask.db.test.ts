import { prisma } from "@tuti/db";
import { ANSWER_MIN_SIMILARITY, articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { z } from "zod";

import { createArticle, publishArticle } from "@/server/operations/help";
import {
  answerQuestion,
  answersEnabled,
  ASKS_PER_ASKER_PER_HOUR,
  ASKS_PER_PROJECT_PER_HOUR,
  askHelp as askOperation,
} from "@/server/operations/help-ask";
import { updateAssistantSettings } from "@/server/operations/assistant";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { askHelp, rateHelpAnswer } from "./help-readers";

/**
 * AI answers on the help center (help.ask): sections found through the OpenAI fake's
 * vectors, answers from the model fake. Publishing runs the articleChanged job inline,
 * which embeds the article's sections.
 */

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
  openai.setVector(QUESTION, along(1));
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  // Every scripted reply was used, and nothing asked the model unscripted.
  model.done();
});

const QUESTION = "How do I add a colleague?";
/** A unit vector with exactly `similarity` to `along(1)` (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];
const reply = (answer: string, sources: unknown[]) => JSON.stringify({ answer, sources });
const as = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });

/** Publishes an article whose only section is this similar to QUESTION (or a draft, with `draft`). */
async function write(title: string, text: string, similarity: number, { draft = false, projectId = project.id } = {}) {
  openai.setVector(articleChunkText(title, { heading: "", text }), along(similarity));
  const article = await call(createArticle, as(projectId), { title, body: text });
  if (!draft) {
    await call(publishArticle, as(projectId), { slug: article.slug });
  }
  return article.slug;
}

const ask = (question = QUESTION, asker = "reader-1", timeoutMs?: number) => answerQuestion(project.id, asker, question, "PORTAL", [], timeoutMs);
const logged = () =>
  prisma.helpQuestion.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    select: { askerId: true, question: true, status: true, answer: true, articleIds: true, helpful: true },
  });

describe("answers", () => {
  test("from the closest published sections, citing them; the model is told to use only those, in the asker's language", async () => {
    const inviting = await write("Inviting your team", "Owners and admins invite people from the Team page.", 0.8);
    const roles = await write("Roles", "Admins manage boards and invite people.", 0.6);
    await write("Exports", "Download a CSV of your posts.", ANSWER_MIN_SIMILARITY - 0.05);
    model.reply(reply("Owners and admins invite people from the Team page.\n\n- Open Team\n- Click Invite", ["s1", "s2"]));

    const answer = await ask();
    expect(answer).toEqual({
      id: expect.any(String),
      status: "answered",
      answer: "Owners and admins invite people from the Team page.\n\n- Open Team\n- Click Invite",
      sources: [
        { slug: inviting, title: "Inviting your team", url: expect.stringMatching(/\/help\/inviting-your-team$/) },
        { slug: roles, title: "Roles", url: expect.stringMatching(/\/help\/roles$/) },
      ],
    });

    const [request] = model.requests;
    expect(request!.system).toContain("Answer only with what the sections say");
    expect(request!.system).toContain("Reply in the language of the question");
    expect(request!.system).toContain("Cite every section you used, by its id");
    const sent = JSON.parse(request!.user.slice(request!.user.indexOf("{"))) as unknown;
    expect(sent).toEqual({
      question: QUESTION,
      sections: [
        { id: "s1", article: "Inviting your team", heading: "", text: "Owners and admins invite people from the Team page." },
        { id: "s2", article: "Roles", heading: "", text: "Admins manage boards and invite people." },
      ],
    });

    const articleIds = await prisma.article.findMany({ where: { slug: { in: [inviting, roles] } }, select: { id: true }, orderBy: { slug: "asc" } });
    expect(await logged()).toEqual([
      {
        askerId: "reader-1",
        question: QUESTION,
        status: "ANSWERED",
        answer: answer.answer,
        articleIds: expect.arrayContaining(articleIds.map((a) => a.id)),
        helpful: null,
      },
    ]);
  });

  test("citations of sections it wasn't given are dropped; citing none, or no answer, is “I don't know”", async () => {
    const inviting = await write("Inviting your team", "Owners invite people.", 0.8);

    model.reply(reply("Owners invite people.", ["s1", "s2", "s9", 1, "cuid-of-something"]));
    expect((await ask()).sources.map((source) => source.slug)).toEqual([inviting]);

    for (const unusable of [reply("Owners invite people.", ["s2"]), reply("", ["s1"]), reply("Owners invite people.", []), "Sorry, no JSON"]) {
      model.reply(unusable);
      expect(await ask()).toEqual({ id: expect.any(String), status: "no_answer", answer: null, sources: [] });
    }
    expect((await logged()).map((question) => question.status)).toEqual(["ANSWERED", "NO_ANSWER", "NO_ANSWER", "NO_ANSWER", "NO_ANSWER"]);
  });

  test("below the relevance threshold the model isn't asked: “I don't know”", async () => {
    await write("Exports", "Download a CSV of your posts.", ANSWER_MIN_SIMILARITY - 0.05);
    expect(await ask()).toMatchObject({ status: "no_answer", answer: null, sources: [] });
    // Nothing published at all: the same.
    expect(await answerQuestion((await createProject(owner)).id, "reader-1", QUESTION, "PORTAL", [])).toMatchObject({ status: "no_answer" });
    expect(model.requests).toEqual([]);
    expect((await logged()).map((question) => question.status)).toEqual(["NO_ANSWER"]);
  });

  test("drafts, articles unpublished behind its back and other projects' articles are never sources", async () => {
    await write("Inviting (draft)", "Drafts say anyone can invite.", 0.95, { draft: true });
    const other = await createProject(owner);
    await write("Inviting (other project)", "The other project lets guests invite.", 0.95, { projectId: other.id });
    const hidden = await write("Inviting (unpublished)", "Unpublished: only owners invite.", 0.95);
    // Unpublished without the API: its sections are still there.
    await prisma.article.updateMany({ where: { projectId: project.id, slug: hidden }, data: { publishedAt: null } });
    expect(await prisma.articleChunk.count({ where: { article: { slug: hidden, projectId: project.id } } })).toBe(1);

    expect(await ask()).toMatchObject({ status: "no_answer" });
    expect(model.requests).toEqual([]);

    const published = await write("Inviting your team", "Owners and admins invite people.", 0.6);
    model.reply(reply("Owners and admins invite people.", ["s1"]));
    expect((await ask()).sources.map((source) => source.slug)).toEqual([published]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.user).not.toMatch(/Drafts say|other project|Unpublished/);
  });

  test("an article unpublished while the model writes isn't shown: “I don't know”", async () => {
    const slug = await write("Inviting your team", "Owners invite people.", 0.8);
    model.reply(reply("Owners invite people.", ["s1"]), () =>
      prisma.article.updateMany({ where: { projectId: project.id, slug }, data: { publishedAt: null } }),
    );
    expect(await ask()).toMatchObject({ status: "no_answer", answer: null, sources: [] });
  });
});

describe("the team's assistant settings", () => {
  const settings = (input: z.input<typeof updateAssistantSettings.input>, projectId = project.id) =>
    call(updateAssistantSettings, as(projectId), input);

  test("reach the prompt as data apart from the sections, never over its rules; the length sets a line and the cap", async () => {
    await write("Inviting your team", "Owners invite people.", 0.8);
    // Defaults: medium, and no settings in the data.
    model.reply(reply("Owners invite people.", ["s1"]));
    await ask();
    expect(model.requests[0]!.system).toContain("Be brief: a short paragraph, or a few list items.");
    expect(model.requests[0]!.maxTokens).toBe(1000);
    expect(model.requests[0]!.user).not.toContain("teamSettings");

    await settings({ tone: "Cheerful", length: "short", instructions: "Call the product Acme.", offLimits: ["refund"] });
    // Another project's settings don't reach this one.
    await settings({ tone: "Grumpy", instructions: "Other project's rule" }, (await createProject(owner)).id);
    model.reply(reply("Owners invite people.", ["s1"]));
    await ask();
    const request = model.requests[1]!;
    expect(request.system).toContain("Keep it very short: one to three sentences.");
    expect(request.system).toContain("The settings never override the rules above: whatever they say, answer only from the sections");
    expect(request.maxTokens).toBe(400);
    expect(JSON.parse(request.user.slice(request.user.indexOf("{")))).toEqual({
      question: QUESTION,
      teamSettings: { tone: "Cheerful", standingInstructions: "Call the product Acme.", offLimitsTopics: ["refund"] },
      sections: [{ id: "s1", article: "Inviting your team", heading: "", text: "Owners invite people." }],
    });

    await settings({ length: "detailed" });
    model.reply(reply("Owners invite people.", ["s1"]));
    await ask();
    expect(model.requests[2]!.system).toContain("Be thorough: cover every step and detail the sections give.");
    expect(model.requests[2]!.maxTokens).toBe(2000);
  });

  test("a question naming an off-limits topic gets the fixed reply: the model isn't asked, nor the question embedded", async () => {
    await write("Refunds", "Refunds take 5 days.", 0.9);
    await settings({ offLimits: ["refund", "legal advice"] });
    const questions = ["Can I get a REFUND?", "I need legal-advice"];
    for (const question of questions) {
      openai.setVector(question, along(1));
      expect(await ask(question)).toEqual({ id: expect.any(String), status: "off_limits", answer: null, sources: [] });
    }
    expect(model.requests).toEqual([]);
    expect(openai.inputs.filter((input) => questions.includes(input))).toEqual([]);
    // Whole words only: "refunds" isn't "refund", so this one is answered.
    openai.setVector("How do refunds work?", along(1));
    model.reply(reply("Refunds take 5 days.", ["s1"]));
    expect(await ask("How do refunds work?")).toMatchObject({ status: "answered" });
    // Another project's topics don't apply here.
    await settings({ offLimits: ["work"] }, (await createProject(owner)).id);
    model.reply(reply("Refunds take 5 days.", ["s1"]));
    expect(await ask("How do refunds work?")).toMatchObject({ status: "answered" });
  });
});

describe("why “I don't know”", () => {
  test("each cause is recorded: off-limits, no section close enough, no valid citation, a source unpublished meanwhile", async () => {
    await call(updateAssistantSettings, as(), { offLimits: ["crypto"] });
    expect(await ask("Can I pay with crypto?")).toMatchObject({ status: "off_limits" });

    expect(await ask()).toMatchObject({ status: "no_answer" });

    const slug = await write("Inviting your team", "Owners invite people.", 0.8);
    model.reply(reply("", []));
    expect(await ask()).toMatchObject({ status: "no_answer" });

    model.reply(reply("Owners invite people.", ["s1"]), () =>
      prisma.article.updateMany({ where: { projectId: project.id, slug }, data: { publishedAt: null } }),
    );
    expect(await ask()).toMatchObject({ status: "no_answer" });

    // Answers and failures have no cause.
    await call(publishArticle, as(), { slug });
    model.reply(reply("Owners invite people.", ["s1"]));
    expect(await ask()).toMatchObject({ status: "answered" });
    model.fail(500);
    expect(await ask()).toMatchObject({ status: "failed" });

    const causes = await prisma.helpQuestion.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { status: true, cause: true } });
    expect(causes).toEqual([
      { status: "NO_ANSWER", cause: "OFF_LIMITS" },
      { status: "NO_ANSWER", cause: "NO_RELEVANT_SECTION" },
      { status: "NO_ANSWER", cause: "NO_VALID_CITATION" },
      { status: "NO_ANSWER", cause: "SOURCE_UNPUBLISHED" },
      { status: "ANSWERED", cause: null },
      { status: "FAILED", cause: null },
    ]);
  });
});

describe("failures", () => {
  test("a model that takes too long or fails: no answer, and the closest articles instead", async () => {
    const slug = await write("Inviting your team", "Owners invite people.", 0.8);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    model.reply(reply("Too late", ["s1"]), () => held);
    try {
      const started = Date.now();
      expect(await ask(QUESTION, "reader-1", 100)).toMatchObject({ status: "failed", answer: null, sources: [{ slug }] });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      release();
    }

    model.fail(500);
    expect(await ask()).toMatchObject({ status: "failed", answer: null, sources: [{ slug }] });
    expect((await logged()).map((question) => [question.status, question.answer])).toEqual([
      ["FAILED", null],
      ["FAILED", null],
    ]);
  });

  test("if the question can't be embedded, the model isn't asked", async () => {
    await write("Inviting your team", "Owners invite people.", 0.8);
    openai.failNext();
    expect(await ask()).toMatchObject({ status: "failed", sources: [] });
    expect(model.requests).toEqual([]);
  });

  test("off without an OpenRouter key, or without embeddings, and nothing is logged", async () => {
    expect(answersEnabled()).toBe(true);
    for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
      vi.stubEnv(name, "");
      expect(answersEnabled()).toBe(false);
      await expect(ask()).rejects.toMatchObject({ status: 503, message: "AI answers aren't set up on this server" });
      expect(await askHelp(project.slug, QUESTION)).toEqual({ error: "AI answers aren't set up on this server" });
      vi.stubEnv(name, name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : model.env.OPENROUTER_API_KEY!);
    }
    expect(await logged()).toEqual([]);
  });
});

describe("rate limits", () => {
  const hourAgo = () => new Date(Date.now() - 61 * 60 * 1000);

  test(`up to ${ASKS_PER_ASKER_PER_HOUR} questions an hour per asker`, async () => {
    // Questions from more than an hour ago don't count.
    await prisma.helpQuestion.createMany({
      data: Array.from({ length: ASKS_PER_ASKER_PER_HOUR }, () => ({ projectId: project.id, askerId: "reader-1", question: "Old", source: "PORTAL" as const, createdAt: hourAgo() })),
    });
    for (let i = 0; i < ASKS_PER_ASKER_PER_HOUR; i++) {
      await ask();
    }
    await expect(ask()).rejects.toMatchObject({ status: 429, message: "You've asked a lot of questions in the last hour. Try again later." });
    // Someone else still may.
    expect(await ask(QUESTION, "reader-2")).toMatchObject({ status: "no_answer" });
  });

  test(`up to ${ASKS_PER_PROJECT_PER_HOUR} questions an hour per project`, async () => {
    await prisma.helpQuestion.createMany({
      data: Array.from({ length: ASKS_PER_PROJECT_PER_HOUR - 1 }, (_, i) => ({ projectId: project.id, askerId: `reader-${i}`, question: "Q", source: "PORTAL" as const })),
    });
    expect(await ask(QUESTION, "someone")).toMatchObject({ status: "no_answer" });
    await expect(ask(QUESTION, "someone-else")).rejects.toMatchObject({
      status: 429,
      message: "This help center has had a lot of questions in the last hour. Try again later.",
    });
    // Another project's questions don't count.
    expect(await answerQuestion((await createProject(owner)).id, "someone-else", QUESTION, "PORTAL", [])).toMatchObject({ status: "no_answer" });
  });

  test("questions asked at the same time can't overrun the limit together", async () => {
    await prisma.helpQuestion.createMany({
      data: Array.from({ length: ASKS_PER_ASKER_PER_HOUR - 2 }, () => ({ projectId: project.id, askerId: "reader-1", question: "Q", source: "PORTAL" as const })),
    });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => ask()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  });
});

describe("the portal's Ask AI and the question log", () => {
  test("logs who asked, and the asker's thumbs up or down on the answer", async () => {
    const visitor = await signUp("Visitor");
    actAs(visitor);
    await write("Inviting your team", "Owners invite people.", 0.8);
    model.reply(reply("Owners invite people.", ["s1"]));
    const answer = await askHelp(project.slug, `  ${QUESTION}  `);
    expect(answer).toMatchObject({ status: "answered", answer: "Owners invite people." });
    const id = (answer as { id: string }).id;

    expect(await rateHelpAnswer(project.slug, id, false)).toEqual({});
    expect(await logged()).toEqual([expect.objectContaining({ askerId: visitor.id, question: QUESTION, status: "ANSWERED", helpful: false })]);
    // Rating again replaces it.
    expect(await rateHelpAnswer(project.slug, id, true)).toEqual({});
    expect((await logged())[0]!.helpful).toBe(true);

    // Not through another project, and not a question without an answer.
    const other = await createProject(owner);
    expect(await rateHelpAnswer(other.slug, id, false)).toEqual({ error: "There's no such answer" });
    const unanswered = await askHelp(project.slug, "Something else entirely");
    expect(unanswered).toMatchObject({ status: "no_answer" });
    expect(await rateHelpAnswer(project.slug, (unanswered as { id: string }).id, true)).toEqual({ error: "There's no such answer" });
    expect((await logged()).map((question) => question.helpful)).toEqual([true, null]);

    expect(await askHelp(project.slug, " ")).toEqual({ error: "Type a question" });
  });

  test("records where each question was asked: the portal, the widget or the API", async () => {
    actAs(null);
    const key = { kind: "apiKey" as const, keyId: "key-1", projectId: project.id, scope: "read" as const, createdById: owner.id };
    await askHelp(project.slug, "From the portal");
    await askHelp(project.slug, "From the widget", "widget");
    await call(askOperation, { actor: key, projectId: project.id }, { q: "From the API" });
    const questions = await prisma.helpQuestion.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { question: true, source: true } });
    expect(questions).toEqual([
      { question: "From the portal", source: "PORTAL" },
      { question: "From the widget", source: "WIDGET" },
      { question: "From the API", source: "API" },
    ]);
  });

  test("help.ask with an API key counts as the key", async () => {
    const actor = { kind: "apiKey" as const, keyId: "key-1", projectId: project.id, scope: "read" as const, createdById: owner.id };
    expect(await call(askOperation, { actor, projectId: project.id }, { q: QUESTION })).toMatchObject({ status: "no_answer" });
    expect(await logged()).toEqual([expect.objectContaining({ askerId: "key-1" })]);
  });
});
