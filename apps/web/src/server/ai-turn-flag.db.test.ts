import { prisma } from "@tuti/db";
import { ANSWER_MIN_SIMILARITY, articleChunkText } from "@tuti/shared";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
// A server whose provider has no Decisions API.
vi.mock("@tuti/shared", async (original) => ({ ...(await original<typeof import("@tuti/shared")>()), decisionsAvailable: () => false }));

import { actAs, createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";

import { runAiTurn } from "./ai-turn";
import { mailSubdomain, supportAddress } from "./inbound";
import { createArticle, publishArticle } from "./operations/docs";
import { call } from "./operations/run";

/** The AI's turn on a server without a decision model (docs/plan.md, Inbox automation, W12): the answer model says whether the user asks for a person. */

const DOMAIN = "tuti.email";
let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => Promise.all([model.embeddings.close(), model.close()]));
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
  model.requests.length = 0;
});

test("the answer model's flag hands it over for the user asking; it's never logged as a gap in the docs", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, emailAiFirst: true } });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const text = "Settings → Export downloads everything as CSV.";
  const similar = [ANSWER_MIN_SIMILARITY + 0.1, Math.sqrt(1 - (ANSWER_MIN_SIMILARITY + 0.1) ** 2)];
  model.embeddings.setVector(articleChunkText("Exporting", { heading: "", text }), similar);
  await call(publishArticle, admin, { slug: (await call(createArticle, admin, { title: "Exporting", body: text })).slug });
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  actAs(null);
  model.embeddings.setVector("Can I talk to someone about exports?", [1, 0]);
  await postEmail(rawEmail({ from: "e2e-sender@example.com", to, body: "Can I talk to someone about exports?" }), { recipient: to });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  expect(conversation.handledBy).toBe("AI");

  model.reply(JSON.stringify({ answer: "", sources: [], person: true }), undefined, "Answer the question from these sections");
  model.reply("They want to talk to someone about exports.", undefined, "askedBefore");
  expect(await runAiTurn(conversation.id)).toBe("handed_over");
  // The answer model was told it may say so.
  expect(model.requests[0]!.messages[0]!.content).toContain('"person": true');
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).handledBy).toBe("TEAM");
  expect(await prisma.conversationEvent.findMany({ where: { conversationId: conversation.id, kind: "handed_over" }, select: { details: true } })).toEqual([{ details: { reason: "user_asked" } }]);
  expect(await prisma.docsQuestion.findMany({ where: { projectId: project.id }, select: { status: true, cause: true } })).toEqual([{ status: "FAILED", cause: null }]);
});

test("a request for a person that matches no article is still read by the answer model: handed over because they asked, never logged as a gap", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, emailAiFirst: true } });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const text = "Settings → Export downloads everything as CSV.";
  await call(publishArticle, admin, { slug: (await call(createArticle, admin, { title: "Exporting", body: text })).slug });
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  actAs(null);
  // Nothing in the docs is close to it.
  await postEmail(rawEmail({ from: "e2e-sender@example.com", to, body: "Can I talk to a human please?" }), { recipient: to });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });

  model.reply(JSON.stringify({ answer: "", sources: [], person: true }), undefined, "Answer the question from these sections");
  model.reply("They want to talk to a human.", undefined, "askedBefore");
  expect(await runAiTurn(conversation.id)).toBe("handed_over");
  // Asked with no sections, told it may say they ask for a person.
  expect(model.requests[0]!.messages[0]!.content).toContain('"person": true');
  expect(model.requests[0]!.messages.at(-1)!.content).toContain('"sections": []');
  expect(await prisma.conversationEvent.findMany({ where: { conversationId: conversation.id, kind: "handed_over" }, select: { details: true } })).toEqual([{ details: { reason: "user_asked" } }]);
  expect(await prisma.docsQuestion.findMany({ where: { projectId: project.id }, select: { status: true, cause: true } })).toEqual([{ status: "FAILED", cause: null }]);
});

test("a request for a person that names an off-limits topic is read by the answer model too: handed over because they asked, not as off-limits", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, emailAiFirst: true, assistantOffLimits: ["refunds"] } });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  await call(publishArticle, admin, { slug: (await call(createArticle, admin, { title: "Exporting", body: "Settings → Export downloads everything as CSV." })).slug });
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  actAs(null);
  await postEmail(rawEmail({ from: "e2e-sender@example.com", to, body: "I want a person to talk about refunds" }), { recipient: to });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });

  model.reply(JSON.stringify({ answer: "", sources: [], person: true }), undefined, "Answer the question from these sections");
  model.reply("They want a person about refunds.", undefined, "askedBefore");
  expect(await runAiTurn(conversation.id)).toBe("handed_over");
  // Asked with no sections and a small cap, only for the flag.
  expect(model.requests[0]!.messages.at(-1)!.content).toContain('"sections": []');
  expect(model.requests[0]!.maxTokens).toBe(50);
  expect(await prisma.conversationEvent.findMany({ where: { conversationId: conversation.id, kind: "handed_over" }, select: { details: true } })).toEqual([{ details: { reason: "user_asked" } }]);
  expect(await prisma.docsQuestion.findMany({ where: { projectId: project.id }, select: { status: true, cause: true } })).toEqual([{ status: "FAILED", cause: null }]);
});

/** A project whose email the AI answers first, with one article; an email from a stranger saying `body`; its conversation. */
async function emailed(body: string, { offLimits = [] as string[] } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, emailAiFirst: true, assistantOffLimits: offLimits } });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  await call(publishArticle, admin, { slug: (await call(createArticle, admin, { title: "Exporting", body: "Settings → Export downloads everything as CSV." })).slug });
  const to = supportAddress(await mailSubdomain(project.id), DOMAIN);
  actAs(null);
  await postEmail(rawEmail({ from: "e2e-sender@example.com", to, body }), { recipient: to });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  /** Why it was handed over, and how its question was logged. */
  const outcome = async () => ({
    reasons: (await prisma.conversationEvent.findMany({ where: { conversationId: conversation.id, kind: "handed_over" }, select: { details: true } })).map((row) => (row.details as { reason: string }).reason),
    questions: await prisma.docsQuestion.findMany({ where: { projectId: project.id }, select: { status: true, cause: true } }),
  });
  return { conversation, outcome };
}

test("a question no article is close to, which the answer model doesn't take for a request for a person: handed over as no answer, logged as a gap", async () => {
  const { conversation, outcome } = await emailed("Do you sell gift cards?");
  model.reply(JSON.stringify({ answer: "", sources: [] }), undefined, "Answer the question from these sections");
  model.reply("They ask about gift cards.", undefined, "askedBefore");
  expect(await runAiTurn(conversation.id)).toBe("handed_over");
  expect(await outcome()).toEqual({ reasons: ["no_answer"], questions: [{ status: "NO_ANSWER", cause: "NO_RELEVANT_SECTION" }] });
});

test("an off-limits question whose flag can't be asked (the answer model failing): handed over as off-limits, as before", async () => {
  const { conversation, outcome } = await emailed("How do refunds work?", { offLimits: ["refunds"] });
  model.fail(500);
  model.reply("They ask about refunds.", undefined, "askedBefore");
  expect(await runAiTurn(conversation.id)).toBe("handed_over");
  expect(model.requests[0]!.messages.at(-1)!.content).toContain('"sections": []');
  expect(await outcome()).toEqual({ reasons: ["off_limits"], questions: [{ status: "NO_ANSWER", cause: "OFF_LIMITS" }] });
});
