import { prisma } from "@tuti/db";
import { translateMessage } from "@tuti/jobs";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { addMessage, announceUserMessage, createConversation, getConversation, listConversations, replyToConversation, translateReply } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { call } from "./operations/run";
import { getSupportSettings, updateSupportSettings } from "./operations/support";
import { summarizeConversation } from "./operations/support-ai";

/** Inbox in the team's language (docs/plan.md L22): customers' messages into the team's, replies into the customer's. */

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("TUTI_CONFIG", "");
});
afterEach(() => {
  model.requests.length = 0;
  model.done();
});

/** The model's answer to a translation request: the language it says (when asked) and the one segment's text. */
const translated = (text: string, language?: string) => JSON.stringify({ ...(language && { language }), segments: { "1": text } });

const GERMAN = "Der Export-Knopf auf der Berichtsseite tut nichts.";
const ENGLISH = "The export button on the reports page does nothing.";

async function setup({ translate = true } = {}) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  if (translate) {
    await call(updateSupportSettings, team, { translate: true });
  }
  return { project, team };
}

/** A conversation in German, its first message translated. */
async function german() {
  const context = await setup();
  model.reply(translated(ENGLISH, "de"));
  await call(createConversation, context.team, { email: "e2e-kai@example.com", body: GERMAN });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: context.project.id } });
  return { ...context, conversation };
}

/** The customer writes again (as the widget and email do: the message is in, then announced). */
async function customerWrites(projectId: string, conversationId: string, body: string) {
  const message = await addMessage(conversationId, projectId, { author: "USER", authorId: null, channel: "WIDGET", body });
  await announceUserMessage(projectId, 1, message);
  return prisma.conversationMessage.findUniqueOrThrow({ where: { id: message.id } });
}

test("the team language defaults to English and Translate conversations to off; both are saved", async () => {
  const { team } = await setup({ translate: false });
  expect(await call(getSupportSettings, team, {})).toMatchObject({ teamLanguage: "en", translate: false });
  expect(await call(updateSupportSettings, team, { teamLanguage: "pt-br", translate: true })).toMatchObject({ teamLanguage: "pt-BR", translate: true });
  await expect(call(updateSupportSettings, team, { teamLanguage: "not a language" })).rejects.toThrow();
});

test("incoming, de → en: translated in the request that detects its language, the original kept, charged as Translation", async () => {
  const { project, team, conversation } = await german();
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.model).toBe("openai/gpt-6.1-terra");
  expect(model.requests[0]!.system).toContain("into English");
  // The model says which language: it isn't told.
  expect(model.requests[0]!.system).toContain('"language"');
  expect(conversation.language).toBe("de");
  const shown = await call(getConversation, team, { number: 1 });
  expect(shown.messages[0]).toMatchObject({ body: GERMAN, teamText: ENGLISH, language: "de", translationError: null });
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { feature: true } })).toEqual([{ feature: "translation" }]);
  // Search reads the translation beside the original.
  // Found by either, the snippet from the text that has it.
  expect((await call(listConversations, team, { q: "export button" })).conversations.map((c) => [c.number, c.match?.snippet])).toEqual([[1, ENGLISH]]);
  expect((await call(listConversations, team, { q: "Berichtsseite" })).conversations.map((c) => [c.number, c.match?.snippet])).toEqual([[1, GERMAN]]);

  // A summary reads the translation beside the original.
  model.reply("They can't export reports.");
  await call(summarizeConversation, team, { number: 1 });
  const sent = JSON.parse(model.requests.at(-1)!.user.slice(model.requests.at(-1)!.user.indexOf("{"))) as { messages: { text: string; translation?: string }[] };
  expect(sent.messages[0]).toMatchObject({ text: GERMAN, translation: ENGLISH });
});

test("spam isn't translated, and an older message translated late doesn't take back the customer's language", async () => {
  const { project, conversation } = await german();
  // A newer message in French, then the German one's retry finishing: the conversation stays French.
  model.reply(translated("I'd like a refund for last month, please.", "fr"));
  await customerWrites(project.id, conversation.id, "Je voudrais un remboursement pour le mois dernier, s'il vous plaît.");
  const first = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  await prisma.conversationMessage.update({ where: { id: first.id }, data: { teamText: null } });
  model.reply(translated(ENGLISH, "de"));
  await translateMessage({ messageId: first.id }, { info: () => {}, warn: () => {} });
  expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).language).toBe("fr");

  await prisma.conversation.update({ where: { id: conversation.id }, data: { spam: true } });
  const spam = await customerWrites(project.id, conversation.id, "Buy cheap watches today from our wonderful shop!");
  expect(model.requests).toHaveLength(3);
  expect(spam).toMatchObject({ teamText: null, translationError: null });
});

test("a message in the team's language isn't translated, but the conversation knows its language", async () => {
  const { project, team } = await setup();
  model.reply(translated(ENGLISH, "en"));
  await call(createConversation, team, { email: "e2e-kai@example.com", body: ENGLISH });
  expect((await call(getConversation, team, { number: 1 })).messages[0]).toMatchObject({ teamText: null, language: "en" });
  expect((await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } })).language).toBe("en");
  // Replies go as written: nothing asked.
  await call(replyToConversation, team, { number: 1, body: "Thanks!" });
  expect(model.requests).toHaveLength(1);
});

test("too short to tell: the conversation's last known language; none known, not translated", async () => {
  const { project, conversation } = await german();
  model.reply(translated("Thanks!"));
  const thanks = await customerWrites(project.id, conversation.id, "Danke!");
  expect(model.requests[1]!.system).toContain("from German into English");
  expect(thanks).toMatchObject({ body: "Danke!", teamText: "Thanks!", language: "de" });

  const other = await setup();
  await call(createConversation, other.team, { email: "e2e-ok@example.com", body: "ok" });
  expect(model.requests).toHaveLength(2);
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: other.project.id } })).toMatchObject({ teamText: null, language: null, translationError: null });
});

test("reply, en → de: previewed, then sent with the preview; the customer gets the German, the team's English kept", async () => {
  const { project, team } = await german();
  model.reply(translated("Danke! Eine Lösung ist unterwegs."));
  const preview = await call(translateReply, team, { number: 1, body: "Thanks! A fix is on its way." });
  expect(preview).toEqual({ status: "translated", text: "Danke! Eine Lösung ist unterwegs.", language: "de", error: null });
  expect(model.requests[1]!.system).toContain("from English into German");

  const reply = { number: 1, body: "Thanks! A fix is on its way.", translation: preview.text!, requestId: "reply-1" };
  const sent = await call(replyToConversation, team, reply);
  // The preview is what's sent: not asked again.
  expect(model.requests).toHaveLength(2);
  expect(sent).toMatchObject({ body: "Danke! Eine Lösung ist unterwegs.", teamText: "Thanks! A fix is on its way.", language: "de" });
  // Sent again (its answer lost): the reply already sent, by the team's own text, nothing translated or written again.
  expect(await call(replyToConversation, team, { ...reply, translation: undefined })).toMatchObject({ id: sent.id });
  expect(model.requests).toHaveLength(2);

  // Without a preview, it's translated as it's sent.
  model.reply(translated("Noch etwas?"));
  expect(await call(replyToConversation, team, { number: 1, body: "Anything else?" })).toMatchObject({ body: "Noch etwas?", teamText: "Anything else?" });
  expect(await prisma.aiUsage.count({ where: { projectId: project.id, feature: "translation" } })).toBe(3);
});

test("a failed translation: the message shows as written with why; a reply is never sent untranslated unless the team says so", async () => {
  const { project, team, conversation } = await german();
  // Asked, and asked again once: the provider doesn't answer either.
  model.fail(500);
  model.fail(500);
  const message = await customerWrites(project.id, conversation.id, "Ich kann mich seit gestern nicht mehr anmelden.");
  expect(message).toMatchObject({ teamText: null, translationError: "The translation provider didn't answer" });

  model.fail(500);
  model.fail(500);
  const refused = await call(replyToConversation, team, { number: 1, body: "Could you try again?" }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(OperationError);
  expect(refused).toMatchObject({ status: 502, code: "translation_failed" });
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM" } })).toBe(0);

  model.fail(500);
  model.fail(500);
  expect(await call(replyToConversation, team, { number: 1, body: "Could you try again?", untranslated: true })).toMatchObject({
    body: "Could you try again?",
    teamText: null,
    language: null,
  });
});

test("internal notes are never translated, and with Translate conversations off nothing is", async () => {
  const { team } = await german();
  const note = await call(replyToConversation, team, { number: 1, body: "Checking with the billing team", note: true });
  expect(note).toMatchObject({ body: "Checking with the billing team", teamText: null });
  expect(model.requests).toHaveLength(1);

  const off = await setup({ translate: false });
  await call(createConversation, off.team, { email: "e2e-kai@example.com", body: GERMAN });
  await call(replyToConversation, off.team, { number: 1, body: "Thanks!" });
  expect(model.requests).toHaveLength(1);
  await expect(call(replyToConversation, off.team, { number: 1, body: "Thanks!", translation: "Danke!" })).rejects.toMatchObject({ status: 400 });
});
