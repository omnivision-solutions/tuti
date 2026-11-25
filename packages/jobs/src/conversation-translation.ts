import { translateText } from "@tuti/content";
import { INBOX_CHANNEL, prisma } from "@tuti/db";
import { complete, type JobInput } from "@tuti/shared";

import { aiFor } from "./ai-usage";
import { OutOfCredits } from "./credits";
import type { JobLogger, JobResult, JobRun } from "./index";

/**
 * Inbox in the team's language (docs/plan.md L22): with "Translate conversations" on, a customer's message in another
 * language is translated into the team's, in the same request that says which language it's in, and the team's replies
 * go out in the customer's. The `translation` AI role, charged like any other. The original is always kept: a message's
 * `body` is the customer's side, its `teamText` the team's.
 */

/** The team's language until projects have a default language of their own (docs/plan.md, Languages, L1). */
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
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { teamLanguage: true, translateConversations: true } });
  return { teamLanguage: project.teamLanguage ?? DEFAULT_TEAM_LANGUAGE, translate: project.translateConversations };
}

/**
 * A customer's message into the team's language (the translate-message job): its language from the model, or, too
 * short to tell, the conversation's last known one (else it isn't translated). The conversation keeps the customer's
 * language. A failure is kept on the message (`translationError`), never thrown past the last try: the message is in.
 */
export async function translateMessage({ messageId }: JobInput<"translateMessage">, log: JobLogger, { lastTry }: JobRun = { lastTry: true }): Promise<JobResult> {
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
      return { skipped: "out of credits" };
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
  /** The translation the team already saw (conversations.translateReply): taken as it is, nothing asked again. */
  seen?: string,
): Promise<null | { text: string; language: string } | { error: string; language: string }> {
  const [{ teamLanguage, translate }, conversation] = await Promise.all([
    translationSettings(projectId),
    prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { language: true } }),
  ]);
  const language = conversation.language;
  if (!translate || !language || sameLanguage(language, teamLanguage)) {
    return null;
  }
  if (seen !== undefined) {
    return { text: seen, language };
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
  return { text: result.text, language };
}
