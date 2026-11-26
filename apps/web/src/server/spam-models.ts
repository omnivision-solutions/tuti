import { prisma } from "@tuti/db";
import { historySince, spamMeter, visibleConversations } from "@tuti/jobs";
import { aiEnabled, complete, config, decide, decisionsAvailable, DEFAULT_AI_MODEL, log, type Meter } from "@tuti/shared";
import { after } from "next/server";

import { notifyInbox } from "./live";

/**
 * The spam filter's model checks (docs/plan.md, Inbox automation, "The spam filter", checks 6 and 7), watching only: a
 * new conversation no free check decided (server/spam.ts) goes to the inbox as ever, and once the request has answered
 * the decision model is asked whether it's spam (at least 0.9 is, at most 0.3 isn't), then the chat model where it
 * wasn't sure. One that would have been filed gets a Tuti note saying so, and why; nothing is held, filed or told.
 *
 * It fails open and costs the project nothing: a model down, the day's cap reached (`spam.requestsPerDay`, the config
 * file) or a server without the models leaves the conversation as it is. The requests are recorded (`spam`), never
 * charged.
 */

/** How much of the message the models read, and of each example. */
export const MESSAGE_CHARS = 2000;
export const EXAMPLE_CHARS = 500;
/** The latest conversations marked each way the models read as examples. */
export const EXAMPLES = 10;
/** The decision model's bands: at least SPAM_AT is spam, at most NOT_SPAM_AT isn't; between them the chat model decides. */
export const SPAM_AT = 0.9;
export const NOT_SPAM_AT = 0.3;
/** When the inbox-due job picks up a conversation whose checks haven't run, from when it started (or was last picked up). */
export const CHECKS_DUE_AFTER_MS = 2 * 60_000;
/** The team's guidance for the models (Settings → Spam). */
export const MAX_SPAM_GUIDANCE = 500;

/** The models this server asks: either may be null (none, `off`, or no Decisions API); both are with the cap at 0. */
export function spamModels(): { decision: string | null; chat: string | null } {
  const { spam, ai } = config();
  if (spam.requestsPerDay === 0 || !aiEnabled()) {
    return { decision: null, chat: null };
  }
  const chat = spam.chat.model ?? ai.model ?? DEFAULT_AI_MODEL;
  return { decision: decisionsAvailable() && spam.decisions.model !== "off" ? spam.decisions.model : null, chat: chat === "off" ? null : chat };
}

/** Whether a new conversation no free check decided is asked of a model here (so has `pathDueAt`). */
export const spamModelsOn = () => Object.values(spamModels()).some(Boolean);

/** A conversation the team marked, as the models read it. */
type Example = { subject: string; text: string };

/** What the models read of a new conversation. */
export type SpamInput = {
  sender: string | null;
  name: string | null;
  subject: string;
  text: string;
  /** What gives mail away: see spamSignals. */
  signals: string[];
  /** The team's own words (Settings → Spam). */
  guidance: string;
  /** The first messages of the latest conversations the team marked each way. */
  examples: { spam: Example[]; notSpam: Example[] };
};

/** Brands a display name passes for most often. */
const BRANDS = `facebook meta instagram whatsapp google gmail youtube apple icloud microsoft outlook office365 paypal amazon netflix
  linkedin tiktok twitter dhl fedex ups usps stripe shopify`.split(/\s+/);
/** Link shorteners, which hide where a link goes. */
const SHORTENERS = new Set("bit.ly tinyurl.com t.co goo.gl ow.ly is.gd buff.ly rebrand.ly cutt.ly shorturl.at rb.gy t.ly tiny.cc s.id lnkd.in".split(" "));

/**
 * What gives mail away, in words for the models: a display name passing for a brand its address isn't at, links through
 * a link shortener, a Reply-To that isn't the sender. Hints, never a verdict on their own.
 */
export function spamSignals({ name, sender, text, replyTo }: { name: string | null; sender: string | null; text: string; replyTo?: string | null }): string[] {
  const signals: string[] = [];
  const domain = sender?.slice(sender.lastIndexOf("@") + 1) ?? "";
  const words = name?.toLowerCase().split(/[^\p{L}\p{N}]+/u) ?? [];
  const brand = BRANDS.find((b) => words.includes(b) && !domain.split(".").includes(b));
  if (brand && name) {
    signals.push(`The display name “${name}” names ${brand}, but the address isn't at ${brand}'s domain`);
  }
  const shortened = [...text.matchAll(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\S/gi)].map((m) => m[1]!.toLowerCase()).find((host) => SHORTENERS.has(host));
  if (shortened) {
    signals.push(`It links through a link shortener (${shortened}), which hides where the link goes`);
  }
  if (replyTo && sender && replyTo !== sender) {
    signals.push(`Replies would go to another address than the sender's (${replyTo})`);
  }
  return signals;
}

const WHAT_SPAM_IS =
  "A message that starts a new conversation with a software company's support team (by email or the chat on its site). Spam is mail the team never wanted: unsolicited sales, SEO, design or development pitches, scams, phishing, fake notices from a brand, mass mailings. Not spam is anyone writing to the team about its product, their account, a purchase, a bug or an idea, complaints, a prospect's question and notices the team signed up for included. The state has the sender, the subject, the start of the message, signals that often give spam away (hints, not proof), the team's own guidance (follow it), and conversations the team marked as spam and as not spam.";

const DECISION = {
  spam: {
    type: "noul" as const,
    instructions: `${WHAT_SPAM_IS} Is this message spam?`,
    criteria: { true: "Spam: a pitch, a scam, phishing, a fake notice or a mass mailing the team never asked for", false: "Not spam: someone writing to the team, however short, angry or oddly worded" },
  },
};

const CHAT_SYSTEM = `${WHAT_SPAM_IS} The user message is that state, as JSON. Answer with JSON alone: {"verdict": "spam" | "not_spam" | "unsure", "why": "one short sentence"}. Say spam only when you're sure: losing a customer's mail costs more than reading one spam.`;

/** One line, cut short: what a model said, as the note quotes it. */
const oneLine = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A model's verdict: `spam`, and why in words (for the note); `by` which check gave it. Null: no answer (left as it is). */
export type SpamJudgement = { spam: boolean; by: "decision" | "chat"; why: string; probability?: number } | null;

/**
 * Checks 6 and 7 on what a conversation says: the decision model first, the chat model between its bands (or alone,
 * without one). Never throws: a model that fails, or `more()` saying the day's cap is reached, answers null. Unsure isn't spam.
 */
export async function judgeSpam(input: SpamInput, models: { decision: string | null; chat: string | null }, meter: Meter, more: () => Promise<boolean> = async () => true): Promise<SpamJudgement> {
  const state = { ...input, text: input.text.slice(0, MESSAGE_CHARS) };
  try {
    if (models.decision) {
      if (!(await more())) {
        return null;
      }
      const { noul } = (await decide(state, DECISION, { meter, model: models.decision })).spam as { noul: number };
      if (noul >= SPAM_AT) {
        return { spam: true, by: "decision", probability: noul, why: `the decision model was ${Math.floor(noul * 100)}% sure it's spam` };
      }
      if (noul <= NOT_SPAM_AT) {
        return { spam: false, by: "decision", probability: noul, why: "the decision model judged it not spam" };
      }
    }
    if (!models.chat || !(await more())) {
      return null;
    }
    const reply = await complete({ system: CHAT_SYSTEM, user: JSON.stringify(state), maxTokens: 300, timeoutMs: 45_000, model: models.chat, meter });
    const { verdict, why } = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? "") as { verdict?: unknown; why?: unknown };
    if (verdict !== "spam" && verdict !== "not_spam" && verdict !== "unsure") {
      throw new Error(`The chat model's verdict wasn't one of the three: ${oneLine(String(verdict), 50)}`);
    }
    return {
      spam: verdict === "spam",
      by: "chat",
      why: verdict === "spam" ? `the chat model judged it spam${typeof why === "string" && why.trim() ? ` (${oneLine(why)})` : ""}` : `the chat model judged it ${verdict === "unsure" ? "unsure" : "not spam"}`,
    };
  } catch (error) {
    log.warn("The spam filter's model check failed: the conversation stays in the inbox", { error });
    return null;
  }
}

/** The first message of a conversation, cut to `chars`. */
const firstMessage = { where: { author: "USER" as const, note: false }, orderBy: { createdAt: "asc" as const }, take: 1, select: { body: true } };

/** What the models read of a conversation: its sender, subject, first message and signals, the team's guidance and its marked examples. */
async function inputOf(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      projectId: true,
      subject: true,
      email: true,
      name: true,
      pathDueAt: true,
      spam: true,
      spamMarkedAt: true,
      user: { select: { email: true, name: true } },
      project: { select: { spamGuidance: true } },
      messages: firstMessage,
    },
  });
  if (!conversation?.pathDueAt) {
    return null;
  }
  const { projectId } = conversation;
  if (conversation.spam || conversation.spamMarkedAt) {
    // A teammate has decided (or it's in Spam): nothing to ask.
    return { projectId, input: null };
  }
  const since = await historySince(projectId);
  const marked = (spam: boolean) =>
    prisma.conversation.findMany({
      // From the conversations themselves, as the plan's history shows them: an example is gone with its conversation.
      where: { AND: [visibleConversations(since), { projectId, spam, spamMarkedAt: { not: null }, id: { not: conversationId } }] },
      orderBy: { spamMarkedAt: "desc" },
      take: EXAMPLES,
      select: { subject: true, messages: firstMessage },
    });
  const [spam, notSpam, email] = await Promise.all([
    marked(true),
    marked(false),
    prisma.inboundEmail.findFirst({ where: { projectId, conversationId }, orderBy: { createdAt: "asc" }, select: { replyTo: true } }),
  ]);
  const sender = conversation.email ?? conversation.user?.email.toLowerCase() ?? null;
  const name = conversation.name ?? conversation.user?.name ?? null;
  const text = conversation.messages[0]?.body ?? "";
  const example = (row: { subject: string; messages: { body: string }[] }) => ({ subject: row.subject, text: (row.messages[0]?.body ?? "").slice(0, EXAMPLE_CHARS) });
  const input: SpamInput = {
    sender,
    name,
    subject: conversation.subject,
    text: text.slice(0, MESSAGE_CHARS),
    signals: spamSignals({ name, sender, text, replyTo: email?.replyTo }),
    guidance: conversation.project.spamGuidance,
    examples: { spam: spam.map(example), notSpam: notSpam.map(example) },
  };
  return { projectId, input };
}

/** Whether the project may make another model request today (UTC): its recorded `spam` requests under the cap. */
async function underCap(projectId: string) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const used = await prisma.aiUsage.count({ where: { projectId, feature: "spam", createdAt: { gte: today } } });
  // ponytail: counted before each request, so checks at the same moment can each take the last one; a few over, at most.
  return used < config().spam.requestsPerDay;
}

/**
 * Runs a conversation's model checks, if they're still due (`pathDueAt`): asks the models, then under the conversation's
 * lock, only if no other run finished first, records what they'd have done and clears `pathDueAt`, together. So a check
 * run twice records once. A conversation a teammate marked meanwhile has been decided: the answer is dropped. Returns
 * whether this run was the one that finished it. Never throws.
 */
export async function runSpamChecks(conversationId: string): Promise<boolean> {
  try {
    const read = await inputOf(conversationId);
    if (!read) {
      return false;
    }
    const judgement = read.input && (await judgeSpam(read.input, spamModels(), spamMeter(read.projectId), () => underCap(read.projectId)));
    return await prisma.$transaction(async (tx) => {
      const [conversation] = await tx.$queryRaw<{ pathDueAt: Date | null; spam: boolean; spamMarkedAt: Date | null; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]>`
        SELECT "pathDueAt", "spam", "spamMarkedAt", "number", "userId", "visitorHash", "email" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
      if (!conversation?.pathDueAt) {
        return false;
      }
      await tx.conversation.update({ where: { id: conversationId }, data: { pathDueAt: null } });
      if (judgement?.spam && !conversation.spam && !conversation.spamMarkedAt) {
        // After the conversation's latest message, so it reads in order (as addMessage times them).
        const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`SELECT MAX("createdAt") AS latest FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
        await tx.conversationMessage.create({
          data: {
            projectId: read.projectId,
            conversationId,
            author: "TUTI",
            channel: "APP",
            note: true,
            body: `The spam filter would have filed this: ${judgement.why}.`,
            createdAt: new Date(Math.max(Date.now(), latest ? latest.getTime() + 1 : 0)),
          },
        });
        await notifyInbox(tx, { projectId: read.projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
      }
      return true;
    });
  } catch (error) {
    // Left due: the inbox-due job tries it again.
    log.error("Running a conversation's spam checks failed", { conversationId, error });
    return false;
  }
}

/**
 * Runs the checks once the request that started the conversation has answered (`after`), never before it returns.
 * Outside a request (nothing to answer), the inbox-due job runs them when they're due.
 */
export function spamChecksAfter(conversationId: string) {
  try {
    after(() => runSpamChecks(conversationId));
  } catch {
    // Not in a request: `pathDueAt` has it.
  }
}

/**
 * The inbox-due job's minute (POST /api/inbox/due): the conversations whose checks are due and haven't run (a deploy, a
 * crash). Each is claimed first (its `pathDueAt` moved on), so two minutes at once never both run it. Returns how many
 * this run finished.
 */
export async function runDueInbox(now = new Date()): Promise<{ checked: number }> {
  const due = await prisma.conversation.findMany({ where: { pathDueAt: { lte: now } }, orderBy: { pathDueAt: "asc" }, take: 20, select: { id: true } });
  const done = await Promise.all(
    due.map(async ({ id }) => {
      const { count } = await prisma.conversation.updateMany({ where: { id, pathDueAt: { lte: now } }, data: { pathDueAt: new Date(now.getTime() + CHECKS_DUE_AFTER_MS) } });
      return count === 1 && (await runSpamChecks(id));
    }),
  );
  return { checked: done.filter(Boolean).length };
}
