import { prisma } from "@tuti/db";
import { ANSWER_MIN_SIMILARITY, articleChunkText } from "@tuti/shared";
import { type ModelFake, type S3Fake, startModelFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// What the path leaves to `after`: the turn is run by hand (without its wait), as Next.js would once the request has answered.
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (task: () => unknown) => void later.push(task) }));

import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp } from "@/test/helpers";

import { runAiTurn } from "./ai-turn";
import { rateDocsAnswer } from "./docs-readers";
import { createArticle, publishArticle } from "./operations/docs";
import { replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { upsertProjectUser } from "./project-users";
import { widgetAskPerson, widgetConversation, widgetSendMessage, widgetStartConversation, widgetUploadAttachment } from "./widget-inbox";

/**
 * The widget's Messages with the AI in the conversation (docs/plan.md, Inbox automation, W13): with "Answer with AI first"
 * on, a first message starts a conversation the AI has; its answers come in the thread with their sources and thumbs,
 * "answering" while its turn is due, and Ask a person hands it to the team.
 */

const QUESTION = "How do I export my data?";
const FOLLOW_UP = "And as JSON?";

let model: ModelFake;
let s3: S3Fake;
beforeAll(async () => {
  [model, s3] = await Promise.all([startModelFake(), startS3Fake()]);
});
afterAll(() => Promise.all([model.embeddings.close(), model.close(), s3.close()]));
beforeEach(() => {
  for (const [name, value] of Object.entries({ ...model.env, ...s3.env })) {
    vi.stubEnv(name, value);
  }
  model.embeddings.setVector(QUESTION, [1, 0]);
  // A follow-up is searched with the question before it.
  model.embeddings.setVector(`${QUESTION}\n${FOLLOW_UP}`, [1, 0]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  later.length = 0;
  await prisma.conversation.updateMany({ where: { pathDueAt: { not: null } }, data: { pathDueAt: null } });
  model.done();
  model.requests.length = 0;
  model.decisions.length = 0;
});

const answer = (text: string) => JSON.stringify({ answer: text, sources: ["s1"] });

async function setup({ aiFirst = true } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true, widgetAiFirst: aiFirst } });
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const text = "Settings → Export downloads everything as CSV.";
  model.embeddings.setVector(articleChunkText("Exporting", { heading: "", text }), [ANSWER_MIN_SIMILARITY + 0.1, Math.sqrt(1 - (ANSWER_MIN_SIMILARITY + 0.1) ** 2)]);
  const article = await call(createArticle, team, { title: "Exporting", body: text });
  await call(publishArticle, team, { slug: article.slug });
  const userId = await upsertProjectUser(project.id, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  actAs(null);
  const auth = { token: widgetToken(project.id, userId) };
  const conversation = () => prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: 1 } } });
  return {
    project,
    team,
    auth,
    article,
    conversation,
    turn: async () => runAiTurn((await conversation()).id),
    opened: async () => {
      const opened = await widgetConversation(project.slug, auth, 1);
      if ("error" in opened) {
        throw new Error(opened.error);
      }
      return opened;
    },
  };
}

test("a first message in Messages starts a conversation the AI has: answered in the thread with its sources and thumbs, a follow-up too, then Ask a person hands it to the team", async () => {
  const { project, team, auth, article, conversation, turn, opened } = await setup();
  expect(await widgetStartConversation(project.slug, auth, QUESTION)).toEqual({ number: 1 });
  expect(await conversation()).toMatchObject({ origin: "WIDGET", handledBy: "AI" });
  expect(later).toHaveLength(1);
  // Answering while its turn is due; no "we'll reply" while the AI has it.
  expect(await opened()).toMatchObject({ withAi: true, answering: true, messages: [{ ai: false, body: QUESTION, answer: null }] });

  model.decide({ person: 0.05, reply: 0.9 }, QUESTION);
  model.reply(answer("Go to Settings → Export."), undefined, QUESTION);
  expect(await turn()).toBe("answered");
  const answered = await opened();
  expect(answered).toMatchObject({ withAi: true, answering: false });
  // The answer's text alone (the email's "Sources: …" line is the list under it), its source and its question.
  const [, reply] = answered.messages;
  expect(reply).toMatchObject({ ai: true, fromTeam: true, body: "Go to Settings → Export.", answer: { sources: [{ slug: article.slug, title: "Exporting" }], helpful: null } });
  expect((await prisma.conversationMessage.findFirstOrThrow({ where: { id: reply!.id } })).body).toContain("Sources: Exporting");

  // Thumbs up: kept on the question, and shown so.
  expect(await rateDocsAnswer(project.slug, reply!.answer!.questionId, true)).toEqual({});
  expect((await opened()).messages[1]!.answer).toMatchObject({ helpful: true });

  // A follow-up gets its own turn and answer.
  expect(await widgetSendMessage(project.slug, auth, 1, FOLLOW_UP)).toEqual({});
  expect(await opened()).toMatchObject({ answering: true });
  model.decide({ person: 0.05, reply: 0.9 }, FOLLOW_UP);
  model.reply(answer("Export only makes CSV."), undefined, FOLLOW_UP);
  expect(await turn()).toBe("answered");
  expect((await opened()).messages.map((m) => [m.ai, m.body])).toEqual([
    [false, QUESTION],
    [true, "Go to Settings → Export."],
    [false, FOLLOW_UP],
    [true, "Export only makes CSV."],
  ]);

  // Ask a person: the team's, for "the user asked", with the AI's summary of the latest question and answer as a note.
  model.reply("They want to export as JSON.", undefined, FOLLOW_UP);
  expect(await widgetAskPerson(project.slug, auth, 1)).toEqual({});
  expect(await conversation()).toMatchObject({ handledBy: "TEAM" });
  const events = await prisma.conversationEvent.findMany({ where: { conversationId: (await conversation()).id, kind: "handed_over" }, select: { details: true } });
  expect(events.map((e) => e.details)).toEqual([{ reason: "user_asked" }]);
  expect(await prisma.conversationMessage.findFirst({ where: { conversationId: (await conversation()).id, note: true }, select: { body: true } })).toEqual({
    body: "Summary: They want to export as JSON.",
  });
  expect(await opened()).toMatchObject({ withAi: false, answering: false });
  // Asked again: nothing more.
  expect(await widgetAskPerson(project.slug, auth, 1)).toEqual({});
  expect(await prisma.conversationEvent.count({ where: { conversationId: (await conversation()).id, kind: "handed_over" } })).toBe(1);

  // The team's reply, in the thread; their next message is the team's, with no turn for the AI.
  await call(replyToConversation, team, { number: 1, body: "Hi Sam, JSON is coming soon." });
  expect((await opened()).messages.at(-1)).toMatchObject({ ai: false, fromTeam: true, name: "Olive Owner" });
  await widgetSendMessage(project.slug, auth, 1, "Thanks!");
  expect(await conversation()).toMatchObject({ handledBy: "TEAM", pathDueAt: null });
});

test("a first message with files, or with Answer with AI first off, is the team's as before", async () => {
  const { project, auth, conversation } = await setup();
  const started = await widgetUploadAttachment(project.slug, auth, { filename: "error.png", contentType: "image/png", size: 4 });
  if ("error" in started) {
    throw new Error(started.error);
  }
  await fetch(started.uploadUrl, { method: "PUT", body: "\x89PNG", headers: { "content-type": "image/png" } });
  expect(await widgetStartConversation(project.slug, auth, QUESTION, undefined, [started.id])).toEqual({ number: 1 });
  expect(await conversation()).toMatchObject({ handledBy: "TEAM", pathDueAt: null });
  expect(later).toHaveLength(0);

  const off = await setup({ aiFirst: false });
  expect(await widgetStartConversation(off.project.slug, off.auth, QUESTION)).toEqual({ number: 1 });
  expect(await off.conversation()).toMatchObject({ handledBy: "TEAM", pathDueAt: null });
  // Ask a person on one the team has does nothing.
  expect(await widgetAskPerson(off.project.slug, off.auth, 1)).toEqual({});
  expect(await prisma.conversationEvent.count({ where: { conversationId: (await off.conversation()).id, kind: "handed_over" } })).toBe(1);
});

test("a later message with files, on a conversation the AI has, goes to the team", async () => {
  const { project, auth, conversation } = await setup();
  await widgetStartConversation(project.slug, auth, QUESTION);
  expect(await conversation()).toMatchObject({ handledBy: "AI" });
  const started = await widgetUploadAttachment(project.slug, auth, { filename: "error.png", contentType: "image/png", size: 4 });
  if ("error" in started) {
    throw new Error(started.error);
  }
  await fetch(started.uploadUrl, { method: "PUT", body: "\x89PNG", headers: { "content-type": "image/png" } });
  expect(await widgetSendMessage(project.slug, auth, 1, "Here's the error", [started.id])).toEqual({});
  expect(await conversation()).toMatchObject({ handledBy: "TEAM" });
});
