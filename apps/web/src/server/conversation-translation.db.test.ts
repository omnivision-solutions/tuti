import { prisma } from "@tuti/db";
import { handlers, translateMessage, translationSettings } from "@tuti/jobs";
import { creditsOn, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain } from "./inbound";
import * as inbox from "./inbox";
import { addMessage, announceUserMessage, createConversation, getConversation, listConversations, replyToConversation, translateReply } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { listening, notifyInboxNow, subscribeInbox } from "./live";
import { call } from "./operations/run";
import { getSupportSettings, updateSupportSettings } from "./operations/support";
import { summarizeConversation } from "./operations/support-ai";

/** Queuing a job fails for the keys in `failing` (Hatchet unreachable); everything else is queued as it is. */
const jobs = vi.hoisted(() => ({ failing: new Set<string>() }));
vi.mock("@tuti/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tuti/jobs")>();
  return { ...actual, enqueue: ((key, input) => (jobs.failing.has(key) ? Promise.reject(new Error("Hatchet unreachable")) : actual.enqueue(key, input))) as typeof actual.enqueue };
});

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
  vi.unstubAllEnvs();
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
  return { owner, project, team };
}

/** A conversation in German, its first message translated. */
async function german() {
  const context = await setup();
  model.reply(translated(ENGLISH, "de"));
  await call(createConversation, context.team, { email: `e2e-kai-${context.project.slug}@example.com`, body: GERMAN });
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
  expect(await call(getSupportSettings, team, {})).toMatchObject({ teamLanguage: "pt-BR", translate: true });
  await expect(call(updateSupportSettings, team, { teamLanguage: "not a language" })).rejects.toThrow();
});

test("unset, the team language is the project's default language", async () => {
  const { project, team } = await setup({ translate: false });
  await prisma.project.update({ where: { id: project.id }, data: { language: "de" } });
  expect(await call(getSupportSettings, team, {})).toMatchObject({ teamLanguage: "de" });
  expect(await translationSettings(project.id)).toMatchObject({ teamLanguage: "de" });
});

test("Settings → Inbox: the switch and the team language are saved; without AI on the server the switch can't turn on", async () => {
  const { owner, project, team } = await setup({ translate: false });
  actAs(owner);
  expect(await inbox.setTranslation(project.slug, { translate: true })).toEqual({});
  expect(await inbox.setTranslation(project.slug, { teamLanguage: "de" })).toEqual({});
  expect(await call(getSupportSettings, team, {})).toMatchObject({ teamLanguage: "de", translate: true });

  vi.stubEnv("OPENAI_API_KEY", "");
  // Off still turns off; on says why it can't.
  expect(await inbox.setTranslation(project.slug, { translate: false })).toEqual({});
  expect(await inbox.setTranslation(project.slug, { translate: true })).toEqual({ error: "AI isn't set up on this server, so conversations can't be translated" });
  expect(await call(getSupportSettings, team, {})).toMatchObject({ translate: false });
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

  const reply = { number: 1, body: "Thanks! A fix is on its way.", translation: preview.text!, language: preview.language!, requestId: "reply-1" };
  const sent = await call(replyToConversation, team, reply);
  // The preview is what's sent: not asked again.
  expect(model.requests).toHaveLength(2);
  expect(sent).toMatchObject({ body: "Danke! Eine Lösung ist unterwegs.", teamText: "Thanks! A fix is on its way.", language: "de" });
  // Sent again (its answer lost): the reply already sent, by the team's own text, nothing translated or written again.
  expect(await call(replyToConversation, team, { ...reply, translation: undefined, language: undefined })).toMatchObject({ id: sent.id });
  expect(model.requests).toHaveLength(2);

  // Emailed: the German, with the team's English quoted below it.
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  await mailSubdomain(project.id);
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { emailVerified: true } });
  await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
  await handlers.sendConversationReplies({}, { info: () => {}, warn: () => {} });
  const { text } = await mailbox.latestTo(`e2e-kai-${project.slug}@example.com`);
  expect(text.indexOf("Danke! Eine Lösung ist unterwegs.")).toBeGreaterThan(-1);
  expect(text.indexOf("Danke! Eine Lösung ist unterwegs.")).toBeLessThan(text.indexOf("Original: Thanks! A fix is on its way."));

  // Without a preview, it's translated as it's sent.
  model.reply(translated("Noch etwas?"));
  expect(await call(replyToConversation, team, { number: 1, body: "Anything else?" })).toMatchObject({ body: "Noch etwas?", teamText: "Anything else?" });
  expect(await prisma.aiUsage.count({ where: { projectId: project.id, feature: "translation" } })).toBe(3);
});

test("a user's message sent again with its requestId (an API key writing as them) gets the one already in, translated", async () => {
  const { project } = await setup();
  const owner = await prisma.user.findFirstOrThrow({ where: { teamMemberships: { some: { projectId: project.id } } } });
  const key = { projectId: project.id, actor: { kind: "apiKey" as const, keyId: "key", projectId: project.id, scope: "write" as const, createdById: owner.id } };
  model.reply(translated(ENGLISH, "de"));
  await call(createConversation, key, { user: { id: "kai", name: "Kai", email: "e2e-kai@example.com" }, body: GERMAN });
  const theirs = { number: 1, body: "Ich habe noch eine Frage zu meiner Rechnung.", author: { id: "kai" }, requestId: "theirs-1" };
  model.reply(translated("I have another question about my invoice."));
  const first = await call(replyToConversation, key, theirs);
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ teamText: "I have another question about my invoice." });
  // Its teamText is its translation: the retry is compared with what they sent.
  expect(await call(replyToConversation, key, theirs)).toMatchObject({ id: first.id });
  expect(model.requests).toHaveLength(2);
});

test("a preview is sent only while it's in the customer's language: changed since, it's previewed again", async () => {
  const { project, team, conversation } = await german();
  model.reply(translated("Danke!"));
  const preview = await call(translateReply, team, { number: 1, body: "Thanks!" });
  // The customer writes in French meanwhile.
  model.reply(translated("I'd like a refund for last month, please.", "fr"));
  await customerWrites(project.id, conversation.id, "Je voudrais un remboursement pour le mois dernier, s'il vous plaît.");
  await expect(call(replyToConversation, team, { number: 1, body: "Thanks!", translation: preview.text!, language: preview.language! })).rejects.toMatchObject({
    status: 409,
    code: "translation_outdated",
  });
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM" } })).toBe(0);
});

test("without AI on the server, a project that translates is left alone: messages and replies go as written", async () => {
  const { project, team } = await setup();
  vi.stubEnv("OPENAI_API_KEY", "");
  await call(createConversation, team, { email: "e2e-kai@example.com", body: GERMAN });
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ teamText: null, translationError: null });
  // Even where the customer's language is known: the reply isn't refused.
  await prisma.conversation.updateMany({ where: { projectId: project.id }, data: { language: "de" } });
  expect(await call(replyToConversation, team, { number: 1, body: "Thanks!" })).toMatchObject({ body: "Thanks!", teamText: null, language: null });
  expect(model.requests).toHaveLength(0);
});

test("nothing to translate (only a link): a message and a reply go as written, and the model isn't asked", async () => {
  const { project, team, conversation } = await german();
  const url = "https://acme.test/export";
  expect(await customerWrites(project.id, conversation.id, url)).toMatchObject({ body: url, teamText: null, translationError: null });
  expect(await call(replyToConversation, team, { number: 1, body: url })).toMatchObject({ body: url, teamText: null, language: null });
  expect(model.requests).toHaveLength(1);
});

test("on its last try, any error marks the message as failed; earlier, it's thrown for the retry", async () => {
  const { project, team } = await setup({ translate: false });
  await call(createConversation, team, { email: "e2e-kai@example.com", body: GERMAN });
  await prisma.project.update({ where: { id: project.id }, data: { translateConversations: true } });
  const { id } = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id } });
  const log = { info: () => {}, warn: () => {} };
  // Saving the translation fails (the database went away), not the provider.
  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("The database went away"));
  model.reply(translated(ENGLISH, "de"));
  await expect(translateMessage({ messageId: id }, log, { lastTry: false })).rejects.toThrow("The database went away");
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ teamText: null, translationError: null });

  vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("The database went away"));
  model.reply(translated(ENGLISH, "de"));
  expect(await translateMessage({ messageId: id }, log, { lastTry: true })).toEqual({ failed: "error" });
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ teamText: null, translationError: "Couldn't translate it" });
});

test("a translation that can't be queued is marked as failed, not left looking untranslatable", async () => {
  const { project, team } = await setup();
  jobs.failing.add("translateMessage");
  try {
    await call(createConversation, team, { email: "e2e-kai@example.com", body: GERMAN });
  } finally {
    jobs.failing.clear();
  }
  expect(model.requests).toHaveLength(0);
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id } });
  expect(message).toMatchObject({ teamText: null, translationError: "Couldn't queue its translation" });

  // Tried again, it turns out to be in the team's language: the mark goes.
  model.reply(translated(GERMAN, "en"));
  await translateMessage({ messageId: message.id }, { info: () => {}, warn: () => {} });
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ teamText: null, translationError: null });
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

  // Sent as written: the model isn't asked again.
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

test("out of credits: the message keeps why, and the model isn't asked", async () => {
  const { project, team } = await setup({ translate: false });
  await call(createConversation, team, { email: "e2e-kai@example.com", body: GERMAN });
  await prisma.project.update({ where: { id: project.id }, data: { translateConversations: true } });
  const { id } = await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id } });
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  expect(await translateMessage({ messageId: id }, { info: () => {}, warn: () => {} })).toEqual({ failed: "out of credits" });
  expect(model.requests).toHaveLength(0);
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ teamText: null, translationError: "Out of credits" });
});

test("the app: Try again translates a failed message again; the composer previews a reply, sends it, and hears why one wasn't sent", async () => {
  const { owner, project, conversation } = await german();
  actAs(owner);
  model.fail(500);
  model.fail(500);
  const failed = await customerWrites(project.id, conversation.id, "Ich kann mich seit gestern nicht mehr anmelden.");
  expect(failed.translationError).not.toBeNull();

  // Try again: open Inbox pages (other teammates' too) hear of it at once, before its job runs (held back here).
  await listening();
  const heard: number[] = [];
  const last: number[] = [];
  const stops = [
    subscribeInbox((change) => change.projectId === project.id && change.conversationId === conversation.id, () => heard.push(1)),
    subscribeInbox((change) => change.projectId === project.id && change.conversationId === "last", () => last.push(1)),
  ];
  const held = vi.spyOn(handlers, "translateMessage").mockResolvedValueOnce({ skipped: "held" } as never);
  try {
    expect(await inbox.retryTranslation(project.slug, 1)).toEqual({});
    // NOTIFYs arrive in order: once the marker's heard, so is the retry's.
    await notifyInboxNow({ projectId: project.id, conversationId: "last", userId: null, visitorHash: null });
    await vi.waitFor(() => expect(last).toHaveLength(1));
    expect(heard.length).toBeGreaterThan(0);
  } finally {
    held.mockRestore();
    stops.forEach((stop) => stop());
  }
  // Then translated, asked again.
  model.reply(translated("I haven't been able to sign in since yesterday."));
  await prisma.conversationMessage.update({ where: { id: failed.id }, data: { translationError: "The translation provider didn't answer" } });
  expect(await inbox.retryTranslation(project.slug, 1)).toEqual({});
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({
    teamText: "I haven't been able to sign in since yesterday.",
    translationError: null,
  });
  // Nothing failed now: nothing is asked.
  expect(await inbox.retryTranslation(project.slug, 1)).toEqual({});
  expect(model.requests).toHaveLength(4);

  // The preview under the composer, then sent as it is.
  model.reply(translated("Danke! Eine Lösung ist unterwegs."));
  const preview = await inbox.previewReplyTranslation(project.slug, 1, "Thanks! A fix is on its way.");
  expect(preview).toEqual({ preview: { text: "Danke! Eine Lösung ist unterwegs.", language: "de" } });
  expect(await inbox.replyInConversation(project.slug, 1, "Thanks! A fix is on its way.", false, [], false, undefined, "preview" in preview ? preview.preview! : undefined)).toEqual({});
  expect(model.requests).toHaveLength(5);
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { projectId: project.id, author: "TEAM" } })).toMatchObject({
    body: "Danke! Eine Lösung ist unterwegs.",
    teamText: "Thanks! A fix is on its way.",
  });

  // A preview in a language that's no longer theirs: refused, for a new preview.
  expect(await inbox.replyInConversation(project.slug, 1, "Merci!", false, [], false, undefined, { text: "Merci !", language: "fr" })).toMatchObject({
    translation: "outdated",
    error: expect.any(String),
  });

  // Can't be translated: not sent, why without the API's advice, and "Send in English" sends it as written.
  model.fail(500);
  model.fail(500);
  const refused = await inbox.replyInConversation(project.slug, 1, "Anything else?");
  expect(refused).toEqual({ error: "The translation provider didn't answer. Try again in a moment.", translation: "failed", language: "de" });
  expect(await inbox.replyInConversation(project.slug, 1, "Anything else?", false, [], false, undefined, "untranslated")).toEqual({});
  expect(await prisma.conversationMessage.count({ where: { projectId: project.id, author: "TEAM" } })).toBe(2);
});

test("Try again twice at once translates the message once", async () => {
  const { owner, project, conversation } = await german();
  actAs(owner);
  model.fail(500);
  model.fail(500);
  const failed = await customerWrites(project.id, conversation.id, "Ich kann mich seit gestern nicht mehr anmelden.");
  model.reply(translated("I haven't been able to sign in since yesterday."));
  expect(await Promise.all([inbox.retryTranslation(project.slug, 1), inbox.retryTranslation(project.slug, 1)])).toEqual([{}, {}]);
  // German's, the two failed asks, and one translation: the second Try again found it claimed.
  expect(model.requests).toHaveLength(4);
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ teamText: "I haven't been able to sign in since yesterday.", translationError: null });
});

test("Try again is refused with translation off or without AI, and the message keeps why it failed", async () => {
  const { owner, project, team, conversation } = await german();
  actAs(owner);
  model.fail(500);
  model.fail(500);
  const failed = await customerWrites(project.id, conversation.id, "Ich kann mich seit gestern nicht mehr anmelden.");
  const why = failed.translationError;
  expect(why).not.toBeNull();

  await call(updateSupportSettings, team, { translate: false });
  expect(await inbox.retryTranslation(project.slug, 1)).toEqual({ error: "This project doesn't translate conversations" });
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ translationError: why });

  await prisma.project.update({ where: { id: project.id }, data: { translateConversations: true } });
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(await inbox.retryTranslation(project.slug, 1)).toEqual({ error: "AI isn't set up on this server, so conversations can't be translated" });
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ translationError: why });
  expect(model.requests).toHaveLength(3);
});

test("Try again that can't be queued gives the message back its reason, so it shows Try again again", async () => {
  const { owner, project, conversation } = await german();
  actAs(owner);
  model.fail(500);
  model.fail(500);
  const failed = await customerWrites(project.id, conversation.id, "Ich kann mich seit gestern nicht mehr anmelden.");
  const why = failed.translationError;
  expect(why).not.toBeNull();
  jobs.failing.add("translateMessage");
  try {
    await expect(inbox.retryTranslation(project.slug, 1)).rejects.toThrow("Hatchet unreachable");
  } finally {
    jobs.failing.clear();
  }
  expect(await prisma.conversationMessage.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ teamText: null, translationError: why });
  expect(model.requests).toHaveLength(3);
});
