import { prisma } from "@tuti/db";
import { historySince, visibleConversations } from "@tuti/jobs";
import { aiEnabled, complete, config, creditsEnabled, decide, decisionsAvailable, DEFAULT_AI_MODEL, log, type Meter } from "@tuti/shared";
import { after } from "next/server";

import { logEvents } from "./conversation-events";
import { notifyInbox } from "./live";

/**
 * The spam filter's model checks (docs/plan.md, Inbox automation, "The spam filter", checks 6 and 7), watching only: a
 * new conversation no free check decided (server/spam.ts) goes to the inbox as ever, and once the request has answered
 * the decision model is asked whether it's spam (at least 0.9 is, at most 0.3 isn't), then the chat model where it
 * wasn't sure. One that would have been filed gets a row in its Activity saying so, and why (`spam_would_file`);
 * nothing is held, filed or told.
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
/** How long after its conversation started a check still due is given up (see runDueInbox). */
export const GIVE_UP_AFTER_MS = 60 * 60_000;
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

/**
 * A model's verdict: `spam`, and why in words (Tuti's own words, never the model's, which a sender could
 * steer); `reason`, what the chat model said, for the evaluation alone. `by` which check gave it. Null: no answer.
 */
export type SpamJudgement = { spam: boolean; by: "decision" | "chat"; why: string; reason?: string; probability?: number } | null;

/** A model request taken out of the day's cap before it's sent: its meter records it, and one never answered is given back. */
export type Reserved = { meter: Meter; release: () => Promise<void> };
/** Takes a request of the day's cap for this model, or null where it's reached. */
export type Reserve = (kind: "decision" | "chat", model: string) => Promise<Reserved | null>;

/**
 * Checks 6 and 7 on what a conversation says: the decision model first, the chat model between its bands (or alone,
 * without one). Each request is reserved first (`reserve`). Never throws: a model that fails, or the day's cap reached,
 * answers null. Unsure isn't spam.
 */
export async function judgeSpam(input: SpamInput, models: { decision: string | null; chat: string | null }, reserve: Reserve): Promise<SpamJudgement> {
  const state = { ...input, text: input.text.slice(0, MESSAGE_CHARS) };
  const taken: Reserved[] = [];
  const take = async (kind: "decision" | "chat", model: string) => {
    const reserved = await reserve(kind, model);
    if (reserved) {
      taken.push(reserved);
    }
    return reserved?.meter ?? null;
  };
  try {
    if (models.decision) {
      const meter = await take("decision", models.decision);
      if (!meter) {
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
    const meter = models.chat && (await take("chat", models.chat));
    if (!models.chat || !meter) {
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
      why: verdict === "spam" ? "the chat model judged it spam" : `the chat model judged it ${verdict === "unsure" ? "unsure" : "not spam"}`,
      ...(typeof why === "string" && { reason: oneLine(why) }),
    };
  } catch (error) {
    log.warn("The spam filter's model check failed: the conversation stays in the inbox", { error });
    return null;
  } finally {
    await Promise.all(taken.map((reserved) => reserved.release()));
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
  if (conversation.spam || conversation.spamMarkedAt || !conversation.project.spamGuidance.trim()) {
    // A teammate has decided (or it's in Spam), or the team has cleared its guidance ("AI spam check" off): nothing to ask.
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

/**
 * The day's cap (UTC), per project: a request is recorded (`spam`, never charged) before it's sent, under a lock of the
 * project's, only while today's are under `spam.requestsPerDay`, so a burst of mail can't all see room at once. Its
 * meter fills the row in once it's answered; one never answered is given back.
 */
const reserveFor =
  (projectId: string): Reserve =>
  async (kind, model) => {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const id = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(40, hashtext(${projectId}))`;
      const used = await tx.aiUsage.count({ where: { projectId, feature: "spam", createdAt: { gte: today } } });
      if (used >= config().spam.requestsPerDay) {
        return null;
      }
      const row = await tx.aiUsage.create({
        data: { projectId, feature: "spam", kind, model, inputTokens: 0, outputTokens: 0, credits: creditsEnabled() ? 0 : null },
        select: { id: true },
      });
      return row.id;
    });
    if (!id) {
      return null;
    }
    let answered = false;
    return {
      meter: async (usage) => {
        answered = true;
        await prisma.aiUsage.update({ where: { id }, data: usage }).catch((error: unknown) => log.error("Recording AI usage failed", { projectId, feature: "spam", ...usage, error }));
      },
      release: async () => {
        if (!answered) {
          await prisma.aiUsage.deleteMany({ where: { id } });
        }
      },
    };
  };

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
    const judgement = read.input && (await judgeSpam(read.input, spamModels(), reserveFor(read.projectId)));
    return await prisma.$transaction(async (tx) => {
      const [conversation] = await tx.$queryRaw<{ pathDueAt: Date | null; spam: boolean; spamMarkedAt: Date | null; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]>`
        SELECT "pathDueAt", "spam", "spamMarkedAt", "number", "userId", "visitorHash", "email" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
      if (!conversation?.pathDueAt) {
        return false;
      }
      await tx.conversation.update({ where: { id: conversationId }, data: { pathDueAt: null } });
      // Kept for the models alone (a sign): read, it goes, as it may be another of the sender's addresses.
      await tx.inboundEmail.updateMany({ where: { conversationId, replyTo: { not: null } }, data: { replyTo: null } });
      if (judgement?.spam && !conversation.spam && !conversation.spamMarkedAt) {
        // In its Activity (W16), with the check's result: which model, and the decision model's probability. Nothing of
        // the sender's, nor the model's own words, which a sender could steer.
        await logEvents(tx, conversationId, [
          { kind: "spam_would_file", actor: "spam_filter", details: { by: judgement.by, ...(judgement.probability !== undefined && { probability: judgement.probability }) } },
        ]);
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
  // Checks still due an hour after their conversation started keep failing (a run that throws after the models answered):
  // given up without asking again, so they can't spend the day's requests, the conversation left as it is (fails open).
  const stale = await prisma.conversation.findMany({
    where: { pathDueAt: { lte: now }, createdAt: { lt: new Date(now.getTime() - GIVE_UP_AFTER_MS) } },
    take: 100,
    select: { id: true },
  });
  for (const { id } of stale) {
    const { count } = await prisma.conversation.updateMany({ where: { id, pathDueAt: { lte: now } }, data: { pathDueAt: null } });
    await prisma.inboundEmail.updateMany({ where: { conversationId: id, replyTo: { not: null } }, data: { replyTo: null } });
    if (count === 1) {
      log.error("The spam filter's checks kept failing: given up, the conversation left as it is", { conversationId: id });
    }
  }
  // Never one past the hour, however many the batch above left: those are given up, never asked about.
  const due = await prisma.conversation.findMany({
    where: { pathDueAt: { lte: now }, createdAt: { gte: new Date(now.getTime() - GIVE_UP_AFTER_MS) } },
    orderBy: { pathDueAt: "asc" },
    take: 20,
    select: { id: true },
  });
  const done = await Promise.all(
    due.map(async ({ id }) => {
      const { count } = await prisma.conversation.updateMany({
        where: { id, pathDueAt: { lte: now }, createdAt: { gte: new Date(now.getTime() - GIVE_UP_AFTER_MS) } },
        data: { pathDueAt: new Date(now.getTime() + CHECKS_DUE_AFTER_MS) },
      });
      return count === 1 && (await runSpamChecks(id));
    }),
  );
  return { checked: done.filter(Boolean).length };
}
