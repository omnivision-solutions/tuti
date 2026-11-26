import { hasTextToTranslate, translateText } from "@tuti/content";
import { INBOX_CHANNEL, prisma } from "@tuti/db";
import { aiEnabled, complete, type JobInput, log as serverLog } from "@tuti/shared";

import { aiFor } from "./ai-usage";
import { OutOfCredits } from "./credits";
import type { JobLogger, JobResult, JobRun } from "./index";

/**
 * Inbox in the team's language (docs/plan.md L22): with "Translate conversations" on, a customer's message in another
 * language is translated into the team's, in the same request that says which language it's in, and the team's replies
 * go out in the customer's. The `translation` AI role, charged like any other. The original is always kept: a message's
 * `body` is the customer's side, its `teamText` the team's.
 */

/** The team's language where neither it nor the project's default language is set. */
export const DEFAULT_TEAM_LANGUAGE = "en";

/** A language code as stored: a BCP 47 tag, canonical ("pt-BR"), or null for one Intl doesn't take. */
export function languageCode(value: string): string | null {
  try {
    const [code] = Intl.getCanonicalLocales(value);
    return code && /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** A language's name in English ("German" for de), for the model. */
export const languageName = (code: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;

/** Whether two codes are the same language: en-US and en are, pt-BR and pt are (a translation between them isn't worth asking). */
export const sameLanguage = (a: string, b: string) => a.split("-")[0]!.toLowerCase() === b.split("-")[0]!.toLowerCase();

/**
 * Too short for the model to tell its language ("Danke!", "ok", "Merci beaucoup"): fewer letters than this.
 * ponytail: a letter count, not a per-script rule; a short CJK sentence counts as short too, and takes the conversation's language.
 */
const SHORT_LETTERS = 15;
const isShort = (text: string) => (text.match(/\p{L}/gu) ?? []).length < SHORT_LETTERS;

const ABOUT_MESSAGE = "a customer's message to a support team";
const ABOUT_REPLY = "a support team's reply to a customer";

/** The model, for translateText: one request in the `translation` role. */
async function asker(projectId: string) {
  const ai = await aiFor(projectId, "translation");
  return (system: string, user: string) => complete({ system, user, timeoutMs: 30_000, ...ai });
}

/** A project's team language and whether it translates conversations. */
export async function translationSettings(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { language: true, teamLanguage: true, translateConversations: true } });
  // Unset: the project's default language.
  return { teamLanguage: project.teamLanguage ?? project.language ?? DEFAULT_TEAM_LANGUAGE, translate: project.translateConversations };
}

/**
 * A customer's message into the team's language (the translate-message job): its language from the model, or, too
 * short to tell, the conversation's last known one (else it isn't translated). The conversation keeps the customer's
 * language. A failure is kept on the message (`translationError`), never thrown past the last try: the message is in.
 */
export async function translateMessage(input: JobInput<"translateMessage">, log: JobLogger, run: JobRun = { lastTry: true }): Promise<JobResult> {
  try {
    const result = await translateOne(input, log, run);
    if ("skipped" in result) {
      // Nothing to translate after all (the team's language, too short, spam, no AI): a mark from a queue that failed goes.
      await prisma.conversationMessage.updateMany({ where: { id: input.messageId, teamText: null, translationError: { not: null } }, data: { translationError: null } });
    }
    return result;
  } catch (error) {
    if (!run.lastTry) {
      throw error;
    }
    // Out of tries, whatever went wrong: the message says so, so the team can try again (L22b), never left looking untranslatable.
    log.warn(`Translating message ${input.messageId} failed: ${String(error).slice(0, 300)}`);
    await translationFailed(input.messageId, "Couldn't translate it");
    return { failed: "error" };
  }
}

/** How long the team's email and push about a message wait for its translation, and how often they look. */
const NOTICE_WAITS_MS = 10_000;
const NOTICE_LOOKS_MS = 1_000;

/**
 * A customer's message as the team's email and push tell it (docs/plan.md L22): its translation into the team's language,
 * where it gets one. Both are queued beside the translate-message job, so while it's on its way they wait for it, a
 * little: a translation the job is still to settle (`translationPending`), up to NOTICE_WAITS_MS. Then the text as it is.
 * ponytail: polls the message while waiting, in the notice job's worker slot (at most ~10 s, ending as the translation
 * lands); the job telling the notices when it's done frees the slots, once a release can rely on the worker running it.
 * A translation the job leaves unchanged (the model gave it back as it was) isn't foreseen: that wait runs its course.
 */
export async function noticeText(messageId: string, waitMs = NOTICE_WAITS_MS): Promise<{ text: string; translated: boolean; translatedFrom: string | null }> {
  const until = Date.now() + waitMs;
  for (;;) {
    const message = await prisma.conversationMessage.findUniqueOrThrow({
      where: { id: messageId },
      select: {
        author: true,
        note: true,
        body: true,
        teamText: true,
        language: true,
        translationError: true,
        conversation: { select: { spam: true, language: true, project: { select: { language: true, teamLanguage: true, translateConversations: true } } } },
      },
    });
    // Translated: as the Inbox shows it, its language named where it's known.
    if (message.teamText !== null) {
      return { text: message.teamText, translated: true, translatedFrom: message.language };
    }
    if (!translationPending(message) || Date.now() >= until) {
      return { text: message.body, translated: false, translatedFrom: null };
    }
    await new Promise((resolve) => setTimeout(resolve, NOTICE_LOOKS_MS));
  }
}

/**
 * Whether the translate-message job is still to settle this message: it translates it, or says why it couldn't, or that
 * it's in the team's language (its `language`). Not one it skips without a word (as translateOne does): too short to tell
 * with no language known for the conversation, or in the team's; spam; translation off or no AI.
 */
export function translationPending(message: {
  author: string;
  note: boolean;
  body: string;
  teamText: string | null;
  language: string | null;
  translationError: string | null;
  conversation: { spam: boolean; language: string | null; project: { language: string | null; teamLanguage: string | null; translateConversations: boolean } };
}) {
  const { conversation } = message;
  // As translationSettings has it: unset, the project's default language.
  const teamLanguage = conversation.project.teamLanguage ?? conversation.project.language ?? DEFAULT_TEAM_LANGUAGE;
  if (message.author !== "USER" || message.note || conversation.spam || !conversation.project.translateConversations || !aiEnabled()) {
    return false;
  }
  if (message.teamText !== null || message.translationError !== null || message.language !== null || !hasTextToTranslate(message.body)) {
    return false;
  }
  return !isShort(message.body) || (!!conversation.language && !sameLanguage(conversation.language, teamLanguage));
}

/** Marks a message's translation as failed, where nothing else is stored for it yet (logged, never thrown). */
export async function translationFailed(messageId: string, why: string) {
  await prisma.conversationMessage
    .updateMany({ where: { id: messageId, teamText: null, translationError: null }, data: { translationError: why } })
    .catch((error: unknown) => serverLog.error("Saving a message's translation failure failed", { messageId, error }));
}

async function translateOne({ messageId }: JobInput<"translateMessage">, log: JobLogger, { lastTry }: JobRun): Promise<JobResult> {
  const message = await prisma.conversationMessage.findUnique({
    where: { id: messageId },
    select: {
      author: true,
      note: true,
      body: true,
      teamText: true,
      projectId: true,
      createdAt: true,
      conversation: { select: { id: true, number: true, language: true, spam: true, userId: true, visitorHash: true, email: true } },
    },
  });
  // Spam isn't worth credits, as nobody's told about it either.
  if (!message || message.author !== "USER" || message.note || message.teamText !== null || message.conversation.spam) {
    return { skipped: "nothing to translate" };
  }
  const { teamLanguage, translate } = await translationSettings(message.projectId);
  if (!translate) {
    return { skipped: "translation off" };
  }
  // Turned off on the server since it was switched on: nothing to ask, and nothing a Try again would change.
  if (!aiEnabled()) {
    return { skipped: "AI isn't set up" };
  }
  const { conversation } = message;
  // Too short to tell: the conversation's language, said to the model; unknown, it stays as it is.
  const from = isShort(message.body) ? conversation.language : null;
  if (isShort(message.body) && !from) {
    return { skipped: "too short to tell its language" };
  }
  if (from && sameLanguage(from, teamLanguage)) {
    return { skipped: "in the team's language" };
  }
  const settle = async (data: { teamText?: string | null; language?: string | null; translationError?: string | null }, language?: string) => {
    await prisma.$transaction([
      prisma.conversationMessage.update({ where: { id: messageId }, data }),
      // The customer's language is their newest message's: a retry of an older one finishing late doesn't take it back.
      ...(language
        ? [
            prisma.conversation.updateMany({
              where: { id: conversation.id, messages: { none: { author: "USER", createdAt: { gt: message.createdAt }, language: { not: null } } } },
              data: { language },
            }),
          ]
        : []),
      // Open Inbox pages show it as it is now (apps/web/src/server/live.ts).
      prisma.$executeRaw`SELECT pg_notify(${INBOX_CHANNEL}, ${JSON.stringify({ projectId: message.projectId, conversationId: conversation.id, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email })})`,
    ]);
  };
  let ask;
  try {
    ask = await asker(message.projectId);
  } catch (error) {
    if (error instanceof OutOfCredits) {
      await settle({ translationError: "Out of credits" });
      // A failure, so the reason stays for Try again (a skip would clear it).
      return { failed: "out of credits" };
    }
    throw error;
  }
  const result = await translateText(message.body, { ...(from && { from: languageName(from) }), to: languageName(teamLanguage), about: ABOUT_MESSAGE, ask });
  const language = from ?? (result.detected ? languageCode(result.detected) : null);
  if (language && sameLanguage(language, teamLanguage)) {
    // Already the team's: nothing to show, but the conversation now knows its customer's language.
    await settle({ language, translationError: null }, language);
    return { skipped: "in the team's language" };
  }
  if (result.providerError && !lastTry) {
    // Hatchet tries again; the last try keeps the reason for Try again (L22b).
    throw new Error(`The translation provider didn't answer: ${result.providerError}`);
  }
  if (result.problem || result.providerError) {
    const why = result.providerError ? "The translation provider didn't answer" : `The translation failed its checks: ${result.problem!.reason}`;
    log.warn(`Translating message ${messageId}: ${why}`);
    await settle({ language, translationError: why.slice(0, 500) }, language ?? undefined);
    return { failed: why };
  }
  // A message that was only links, code or numbers comes back as it was: nothing to translate.
  if (result.text === message.body) {
    return { skipped: "nothing to translate" };
  }
  await settle({ teamText: result.text, language, translationError: null }, language ?? undefined);
  return { translated: language ?? "unknown" };
}

/**
 * A reply as the customer will get it: the team's text in the conversation's language, when the project translates
 * conversations and the customer's language is known and isn't the team's; null when it goes as written.
 * `error`: why it couldn't be translated (sending it then takes the team choosing to send it untranslated).
 */
export async function replyTranslation(
  projectId: string,
  conversationId: string,
  text: string,
  /**
   * The translation the team already saw (conversations.translateReply) and the language it's in: taken as it is,
   * nothing asked again, while that's still the customer's language (`outdated` otherwise: preview it again).
   */
  seen?: { text: string; language: string },
): Promise<null | { text: string; language: string } | { error: string; language: string } | { outdated: true }> {
  const [{ teamLanguage, translate }, conversation] = await Promise.all([
    translationSettings(projectId),
    prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { language: true } }),
  ]);
  const language = conversation.language;
  const translated = translate && language && !sameLanguage(language, teamLanguage) ? language : null;
  if (seen) {
    return translated === seen.language ? { text: seen.text, language: translated } : { outdated: true };
  }
  if (!translated || !language) {
    return null;
  }
  // No AI on the server: replies go as written, as customers' messages stay (nothing a Try again would change).
  if (!aiEnabled()) {
    return null;
  }
  let ask;
  try {
    ask = await asker(projectId);
  } catch (error) {
    if (error instanceof OutOfCredits) {
      return { error: "The project is out of credits", language };
    }
    throw error;
  }
  const result = await translateText(text, { from: languageName(teamLanguage), to: languageName(language), about: ABOUT_REPLY, ask });
  if (result.providerError) {
    return { error: "The translation provider didn't answer. Try again in a moment.", language };
  }
  if (result.problem) {
    return { error: `The translation failed its checks: ${result.problem.reason}`, language };
  }
  // Nothing to translate (a link, an emoji, a number): it goes as written.
  return result.text === text ? null : { text: result.text, language };
}
