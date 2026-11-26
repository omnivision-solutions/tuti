import { prisma } from "@tuti/db";
import { historySince, visibleConversations } from "@tuti/jobs";
import { aiEnabled, config, creditsEnabled, decide, decisionsAvailable, log, type Meter } from "@tuti/shared";
import { after } from "next/server";

import { settleHold } from "./inbox-path";

/**
 * The spam filter's model checks (docs/plan.md, Inbox automation, "The spam filter", checks 6 and 7): a new conversation
 * no free check decided (server/spam.ts) is held (`spamHeldAt`), and once the request has answered the decision model is
 * asked whether it's spam (at least 0.95 is; anything less is released, the chat model never asked). Spam is filed
 * with its reason; the rest is released to the inbox with the notices a new conversation gets (server/inbox-path.ts,
 * settleHold).
 *
 * It fails open and costs the project nothing: a model down, the day's cap reached (`spam.requestsPerDay`, the config
 * file) or a crash releases it, at the latest when the inbox-due job finds it held for 2 minutes. The requests are
 * recorded (`spam`), never charged.
 */

/** How much of the message the models read, and of each example. */
export const MESSAGE_CHARS = 2000;
export const EXAMPLE_CHARS = 500;
/** The latest conversations marked each way the models read as examples. */
export const EXAMPLES = 10;
/** The decision model's band: at least this is spam, anything under it is released (the private evaluation set showed it). */
export const SPAM_AT = 0.95;
/** The longest a conversation is held for the models: the inbox-due job releases it then, judged or not. */
export const SPAM_HOLD_MS = 2 * 60_000;
/** The team's guidance for the models (Settings → Spam). */
export const MAX_SPAM_GUIDANCE = 500;

/**
 * The decision model this server asks (check 6), or null: none (`off`, no Decisions API, no AI) or a cap of 0. The
 * config's `spam.chat.model` is read by nothing now: the private evaluation set showed only the decision model fit to file.
 */
export function spamModel(): string | null {
  const { spam } = config();
  return spam.requestsPerDay > 0 && aiEnabled() && decisionsAvailable() && spam.decisions.model !== "off" ? spam.decisions.model : null;
}

/** Whether a new conversation no free check decided is held for the model here (`spamHeldAt`, `pathDueAt`). */
export const spamModelsOn = () => spamModel() !== null;

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

/** The decision model's verdict: spam at SPAM_AT or more, and how sure it was. Null: no answer. */
export type SpamJudgement = { spam: boolean; probability: number } | null;

/** A model request taken out of the day's cap before it's sent: its meter records it, and one never answered is given back. */
export type Reserved = { meter: Meter; release: () => Promise<void> };
/** Takes a request of the day's cap for this model, or null where it's reached. */
export type Reserve = (model: string) => Promise<Reserved | null>;

/**
 * Check 6 on what a conversation says: the decision model, its request reserved first (`reserve`). Never throws: a
 * model that fails, or the day's cap reached, answers null.
 */
export async function judgeSpam(input: SpamInput, model: string, reserve: Reserve): Promise<SpamJudgement> {
  const reserved = await reserve(model);
  if (!reserved) {
    return null;
  }
  try {
    const state = { ...input, text: input.text.slice(0, MESSAGE_CHARS) };
    const { noul } = (await decide(state, DECISION, { meter: reserved.meter, model })).spam as { noul: number };
    return { spam: noul >= SPAM_AT, probability: noul };
  } catch (error) {
    log.warn("The spam filter's model check failed: the conversation is released", { error });
    return null;
  } finally {
    await reserved.release();
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
      spamHeldAt: true,
      user: { select: { email: true, name: true } },
      project: { select: { spamGuidance: true } },
      messages: firstMessage,
    },
  });
  if (!conversation?.pathDueAt) {
    return null;
  }
  const { projectId } = conversation;
  if (!conversation.spamHeldAt) {
    // A teammate has decided: nothing to ask.
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
  async (model) => {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const id = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(40, hashtext(${projectId}))`;
      const used = await tx.aiUsage.count({ where: { projectId, feature: "spam", createdAt: { gte: today } } });
      if (used >= config().spam.requestsPerDay) {
        return null;
      }
      const row = await tx.aiUsage.create({
        data: { projectId, feature: "spam", kind: "decision", model, inputTokens: 0, outputTokens: 0, credits: creditsEnabled() ? 0 : null },
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
 * Runs a held conversation's model checks, if they're still due (`pathDueAt`): asks the models, then settles the hold
 * with their verdict (settleHold, under the conversation's lock, once). A conversation a teammate marked meanwhile has
 * been decided: the answer is dropped. Returns whether this run was the one that settled it. Never throws.
 */
export async function runSpamChecks(conversationId: string): Promise<boolean> {
  try {
    const read = await inputOf(conversationId);
    if (!read) {
      return false;
    }
    const model = spamModel();
    const judgement = read.input && model ? await judgeSpam(read.input, model, reserveFor(read.projectId)) : null;
    return await settleHold(conversationId, judgement);
  } catch (error) {
    // Left due: the inbox-due job releases it.
    log.error("Running a conversation's spam checks failed", { conversationId, error });
    return false;
  }
}

/**
 * Runs the checks once the request that started the conversation has answered (`after`), never before it returns.
 * Outside a request (nothing to answer), the inbox-due job releases it when it's due.
 */
export function spamChecksAfter(conversationId: string) {
  try {
    after(() => runSpamChecks(conversationId));
  } catch {
    // Not in a request: `pathDueAt` has it.
  }
}

/**
 * The inbox-due job's minute (POST /api/inbox/due): the conversations still held at `pathDueAt` (2 minutes on: a model
 * slow or down, a deploy, a crash) are released, asking nothing (it fails open). settleHold claims each under its lock,
 * so a release at once with the models' verdict, or two minutes at once, settle it once. Returns how many this run settled.
 */
export async function runDueInbox(now = new Date()): Promise<{ checked: number }> {
  const due = await prisma.conversation.findMany({ where: { pathDueAt: { lte: now } }, orderBy: { pathDueAt: "asc" }, take: 100, select: { id: true } });
  let checked = 0;
  for (const { id } of due) {
    if (await settleHold(id, null).catch((error: unknown) => log.error("Releasing a held conversation failed", { conversationId: id, error }))) {
      checked++;
    }
  }
  return { checked };
}
