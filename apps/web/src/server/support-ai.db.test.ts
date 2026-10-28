import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { createConversation, getConversation, replyToConversation } from "./operations/conversations";
import { createArticle, publishArticle, unpublishArticle } from "./operations/docs";
import { call } from "./operations/run";
import { suggestReply, summarizeConversation } from "./operations/support-ai";

/** The support inbox's AI (docs/plan.md, Support inbox, item 12): a reply drafted from the docs, and summaries, as the `support` feature. */

let openai: OpenAIFake;
let model: ModelFake;
beforeAll(async () => {
  [openai, model] = await Promise.all([startOpenAIFake(), startModelFake()]);
});
afterAll(() => Promise.all([openai.close(), model.close()]));
beforeEach(() => {
  for (const [name, value] of Object.entries({ ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("AI_CREDITS", "");
});
afterEach(() => {
  model.requests.length = 0;
  model.done();
});

const QUESTION = "How do I add a colleague?";
/** A unit vector with exactly `similarity` to the question's (cosine). */
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  return { project, team };
}

/** Publishes an article whose only section is this similar to what's asked. */
async function write(team: Awaited<ReturnType<typeof setup>>["team"], title: string, text: string, similarity: number) {
  openai.setVector(articleChunkText(title, { heading: "", text }), along(similarity));
  const article = await call(createArticle, team, { title, body: text });
  await call(publishArticle, team, { slug: article.slug });
  return article.slug;
}

test("a reply drafted from the docs to what they asked since the team's last reply, with the articles' links; charged as support", async () => {
  const { project, team } = await setup();
  const slug = await write(team, "Inviting your team", "Owners and admins invite people from the Team page.", 0.8);
  await call(createConversation, team, { email: "e2e-sam@example.com", body: "Hello there" });
  await call(replyToConversation, team, { number: 1, body: "Hi! How can we help?" });
  await prisma.conversationMessage.create({
    data: { projectId: project.id, conversationId: (await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).id, author: "USER", channel: "EMAIL", body: QUESTION },
  });
  openai.setVector(QUESTION, along(1));
  model.reply(JSON.stringify({ answer: "Owners and admins invite people from the Team page.", sources: ["s1"] }));

  const suggested = await call(suggestReply, team, { number: 1 });
  expect(suggested.status).toBe("suggested");
  expect(suggested.draft).toMatch(new RegExp(`^Owners and admins invite people from the Team page\\.\\n\\n- Inviting your team: .*/docs/${slug}$`));
  // Asked with what's still open (not "Hello there", which the team answered), and only from the docs.
  const sent = JSON.parse(model.requests[0]!.user.slice(model.requests[0]!.user.indexOf("{"))) as { question: string };
  expect(sent.question).toBe(QUESTION);
  expect(model.requests[0]!.system).toContain("Answer only with what the sections say");
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } })).toEqual([{ feature: "support" }]);
  // Nothing was sent or added: it's a draft.
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id } })).toBe(3);
});

test("when nothing in the docs is close to what they asked, no draft, and the AI isn't asked", async () => {
  const { team } = await setup();
  await write(team, "Exports", "Download a CSV of your posts.", 0.1);
  await call(createConversation, team, { email: "e2e-sam@example.com", body: QUESTION });
  openai.setVector(QUESTION, along(1));
  expect(await call(suggestReply, team, { number: 1 })).toEqual({ status: "no_answer", draft: null });
  expect(model.requests).toEqual([]);
});

test("an article unpublished while the AI wrote isn't in a draft: no draft then", async () => {
  const { team } = await setup();
  const slug = await write(team, "Inviting your team", "Owners and admins invite people from the Team page.", 0.8);
  await call(createConversation, team, { email: "e2e-sam@example.com", body: QUESTION });
  openai.setVector(QUESTION, along(1));
  model.reply(JSON.stringify({ answer: "Owners and admins invite people from the Team page.", sources: ["s1"] }), () => call(unpublishArticle, team, { slug }));
  expect(await call(suggestReply, team, { number: 1 })).toEqual({ status: "no_answer", draft: null });
});

test("out of AI credits: no draft, and summaries are refused saying so", async () => {
  vi.stubEnv("AI_CREDITS", "on");
  const { team } = await setup();
  await write(team, "Inviting your team", "Owners and admins invite people from the Team page.", 0.8);
  await call(createConversation, team, { email: "e2e-sam@example.com", body: QUESTION });
  openai.setVector(QUESTION, along(1));
  expect(await call(suggestReply, team, { number: 1 })).toEqual({ status: "unavailable", draft: null });
  await expect(call(summarizeConversation, team, { number: 1 })).rejects.toMatchObject({ status: 402, message: "This project is out of AI credits" });
  expect(model.requests).toEqual([]);
});

test("a summary is added as the AI's note: only the team sees it, and the status doesn't move", async () => {
  const { team } = await setup();
  await call(createConversation, team, { email: "e2e-sam@example.com", body: "My October invoice is missing." });
  await call(replyToConversation, team, { number: 1, body: "Looking into it." });
  await call(replyToConversation, team, { number: 1, body: "Billing was on the old plan.", note: true });
  model.reply("They can't find their October invoice; the team is checking with billing.");

  expect(await call(summarizeConversation, team, { number: 1 })).toMatchObject({ body: "Summary: They can't find their October invoice; the team is checking with billing." });
  const conversation = await call(getConversation, team, { number: 1 });
  expect(conversation.status).toBe("waiting");
  expect(conversation.messages.at(-1)).toMatchObject({ author: "ai", note: true, body: expect.stringContaining("Summary:") });
  // The model got the whole conversation, the team's note included.
  const sent = JSON.parse(model.requests[0]!.user) as { messages: { from: string; teamNote?: true; text: string }[] };
  expect(sent.messages).toEqual([
    { from: "user", text: "My October invoice is missing." },
    { from: "team", text: "Looking into it." },
    { from: "team", teamNote: true, text: "Billing was on the old plan." },
  ]);
});
