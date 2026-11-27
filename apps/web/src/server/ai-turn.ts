import { type ConversationOrigin, type MessageChannel, prisma } from "@tuti/db";
import { aiFor, aiPaused, automatedRepliesEmailed } from "@tuti/jobs";
import { decide, decisionsAvailable, log, type Meter } from "@tuti/shared";
import { after } from "next/server";

import { AUTOMATED_REPLIES_PER_HOUR, type HandoverReason } from "@/lib/workflows";

import { readerToSend } from "./docs-search";
import { handOverAndTell } from "./inbox-path";
import { notifyInbox } from "./live";
import { answersEnabled, answerTurn, MAX_EARLIER_TURNS, type Turn } from "./operations/docs-ask";
import { summarize, SUMMARY_TIMEOUT_MS } from "./operations/docs-escalate";

/**
 * The AI's turn in a conversation it has (docs/plan.md, Inbox automation, "The AI's turn", W12): once the request that
 * wrote the user's message has answered, after a few seconds' wait for more (people send "hi", then the question), the
 * user's messages since the last reply are the question and the conversation's earlier messages the context, answered
 * as docs.ask answers (the gate, off-limits topics, sources, credits; a `docs_question` row, source INBOX). It hands
 * over (W11's handOver, so "About to go to a person" runs) when the user asks for a person, the docs can't answer, on an
 * off-limits topic, when it fails or the AI is unavailable, past the automated replies' cap, and when it still hasn't
 * answered 10 minutes on; a handover leaves the team a note with its summary.
 *
 * `conversation.pathDueAt` says a turn is due (set where the message is written to the AI, cleared when the turn is
 * done); the inbox-due job runs one left behind. Every step checks again under the conversation's lock before it writes:
 * a conversation taken over meanwhile drops the answer, and a newer message from the user drops the answer or the
 * handover, leaving that message's turn to answer all of it. The answer carries the user's message as its `requestId`,
 * so a turn run twice replies once, and it's emailed as the workflows' set replies are (send-conversation-replies).
 */

/** How long a turn waits for more messages before it answers. */
export const AI_TURN_WAIT_MS = 4000;
/** When the inbox-due job runs a turn whose request didn't (a deploy, a crash). */
export const AI_TURN_DUE_MS = 60_000;
/**
 * How long a running turn holds the conversation (`pathDueAt` pushed past AI_TURN_DUE_MS, so neither the job nor another
 * turn takes it meanwhile). A turn that crashed is picked up after it, and handed over if its message is 10 minutes old.
 */
const AI_TURN_LEASE_MS = 5 * 60_000;
/** A user's message the AI still hasn't answered this long after it's written is handed over. */
export const AI_TURN_GIVE_UP_MS = 10 * 60_000;
/** Characters of the user's messages a turn asks about. */
const QUESTION_CHARS = 2000;
/**
 * `text` in QUESTION_CHARS: both ends where it's longer, as the question often comes first (then a pasted log) and the
 * latest words say most ("a person please" after a long email).
 */
const newest = (text: string) => {
  if (text.length <= QUESTION_CHARS) {
    return text;
  }
  const half = (QUESTION_CHARS - 3) / 2;
  return `${text.slice(0, Math.floor(half))}\n…\n${text.slice(-Math.ceil(half))}`;
};
/** The conversation's latest messages a turn reads. */
const MESSAGES_READ = 50;
/**
 * At least this sure the user asks for a person, the decision model hands over: low, as the private evaluation set showed
 * that missing a request for a person costs far more than handing over a question early.
 */
export const PERSON_AT = 0.2;
/**
 * Under this sure the latest message needs a reply ("thanks", "ok", a lone "hi"), the turn ends without one: low, so
 * nothing that needs an answer is left silent (the private evaluation set showed it).
 */
export const REPLY_AT = 0.3;

/**
 * Whether a new conversation from `origin` starts with the AI ("AI answers first", by channel): email's switch
 * (`project.emailAiFirst`, off until the team turns it on; Settings → Workflows → AI answers first, W14). The widget's Messages are W13's, "Ask a
 * person" is the user asking, and one the team starts over the API is its own.
 */
export async function aiAnswersFirst(projectId: string, origin: ConversationOrigin): Promise<boolean> {
  if (origin !== "EMAIL") {
    return false;
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { emailAiFirst: true } });
  return !!project?.emailAiFirst;
}

/** Why the AI can't answer here now (W14's "off for"): none where it can. */
export type AiOffReason = "no_ai_answers" | "no_articles" | "out_of_credits";

/** What keeps the AI from answering here now: the server has no answers, the project no published article of its own, or no AI credits. */
export async function aiOffReasons(projectId: string): Promise<AiOffReason[]> {
  if (!answersEnabled()) {
    return ["no_ai_answers"];
  }
  // Sample content (Home's "Add sample content") is never answered from: it isn't the team's docs.
  const [article, paused] = await Promise.all([
    prisma.article.findFirst({ where: { projectId, sample: false, publishedAt: { not: null }, deletedAt: null, listing: { not: "HIDDEN" } }, select: { id: true } }),
    aiPaused(projectId),
  ]);
  return [...(article ? [] : ["no_articles" as const]), ...(paused ? ["out_of_credits" as const] : [])];
}

/** Whether the AI can answer here now: the server has answers, the project has a published article of its own and AI credits. */
export async function aiAvailable(projectId: string): Promise<boolean> {
  return (await aiOffReasons(projectId)).length === 0;
}

/** Whether the latest message that isn't a note is the user's (a team's or the AI's reply answers it). */
export const awaitsReply = (latest: { author: string } | null) => latest?.author === "USER";

/**
 * Whether a conversation's user waits on the team: the latest message that isn't a note is theirs, or their latest message
 * was handed to the team (`handedOverAt`, with the handover's `handed_over` Activity row: one a Don't hand over kept with
 * the AI has none) and no teammate has replied since. An answer from the AI counts as a reply
 * only where it wasn't followed by a handover ("Ask a person" after an AI answer, a workflow's set reply as it went to the
 * team). The one rule for Hand back to the AI: the page offers it, and the action allows it, only where nobody waits.
 */
export async function userWaits(conversationId: string): Promise<boolean> {
  const latest = (author?: "USER") =>
    prisma.conversationMessage.findFirst({
      where: { conversationId, note: false, ...(author ? { author } : { author: { in: ["USER", "TEAM", "AI"] } }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { author: true, createdAt: true, handedOverAt: true },
    });
  const [said, asked] = await Promise.all([latest(), latest("USER")]);
  if (awaitsReply(said)) {
    return true;
  }
  if (!asked?.handedOverAt) {
    return false;
  }
  // Handed to the team, not kept with the AI by a Don't hand over (which marks the message all the same): its Activity row,
  // matched by the handover's own time. handOver writes `handedOverAt` and then the row in one transaction, from one clock,
  // so the row is never earlier; the message's `createdAt` may be (it's timed after the conversation's latest message).
  const [toTeam, replied] = await Promise.all([
    prisma.conversationEvent.count({ where: { conversationId, kind: "handed_over", createdAt: { gte: asked.handedOverAt } } }),
    prisma.conversationMessage.count({ where: { conversationId, author: "TEAM", note: false, createdAt: { gt: asked.createdAt } } }),
  ]);
  return toTeam > 0 && replied === 0;
}

/**
 * Whether the AI would answer this conversation's user if it had the conversation: it can answer here now (aiAvailable),
 * may read them the docs (a private portal's reader), and its answer can reach them (in the widget, a signed-out visitor's; by email only where the address is proven, as
 * toAi requires of an email). Where "Hand back to the AI" is offered. Not in Spam, nor held.
 */
export async function aiWouldAnswer(
  projectId: string,
  conversation: { spam: boolean; spamHeldAt: Date | null; userId: string | null; emailVerified: boolean; visitorHash: string | null },
): Promise<boolean> {
  if (conversation.spam || conversation.spamHeldAt || !(automatedRepliesEmailed(conversation) || conversation.visitorHash)) {
    return false;
  }
  // A private portal answers nobody it doesn't let in from its docs (the turn hands those over at once).
  return (await readerToSend(projectId, conversation.userId)) !== false && (await aiAvailable(projectId));
}

/**
 * Gives the AI its turn for the user's message `messageId`, where it can answer now: a new conversation's (`start`, made
 * the AI's) or one the AI has. Under the conversation's lock: never one in Spam or held by the spam filter, nor a message
 * handed over already (a rerun). Returns whether the AI has the turn; false leaves the caller to hand over.
 */
export async function toAi(projectId: string, conversationId: string, messageId: string, { start = false } = {}): Promise<boolean> {
  if (!start) {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { handledBy: true } });
    if (conversation?.handledBy !== "AI") {
      return false;
    }
  }
  if (!(await aiAvailable(projectId))) {
    return false;
  }
  const due = await prisma.$transaction(async (tx) => {
    const [conversation] = await tx.$queryRaw<
      {
        spam: boolean;
        spamHeldAt: Date | null;
        handledBy: "AI" | "TEAM";
        number: number;
        userId: string | null;
        visitorHash: string | null;
        email: string | null;
        emailVerified: boolean;
      }[]
    >`
      SELECT "spam", "spamHeldAt", "handledBy", "number", "userId", "visitorHash", "email", "emailVerified" FROM "conversation"
      WHERE "id" = ${conversationId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
    if (!conversation || conversation.spam || conversation.spamHeldAt || (!start && conversation.handledBy !== "AI")) {
      return false;
    }
    const message = await tx.conversationMessage.findFirst({ where: { id: messageId, conversationId, author: "USER", handedOverAt: null }, select: { channel: true } });
    // An email whose sender isn't proven would never get the answer (never an automated reply to mail we can't prove):
    // the team has it instead.
    if (!message || (message.channel === "EMAIL" && !automatedRepliesEmailed(conversation))) {
      return false;
    }
    await tx.conversation.update({ where: { id: conversationId }, data: { handledBy: "AI", pathDueAt: new Date(Date.now() + AI_TURN_DUE_MS) } });
    if (conversation.handledBy !== "AI") {
      await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
    }
    return true;
  });
  if (due) {
    try {
      after(async () => {
        await new Promise((resolve) => setTimeout(resolve, AI_TURN_WAIT_MS));
        await runAiTurn(conversationId);
      });
    } catch {
      // Not in a request: `pathDueAt` has it.
    }
  }
  return due;
}

const PERSON = {
  person: {
    type: "noul" as const,
    instructions:
      "A user is writing to a software product's support, where an AI answers from the product's docs first. The state has their latest message and, if any, the conversation's earlier turns. Does the latest message ask to talk to a person (a human, someone on the team, support staff) rather than only for an answer?",
    criteria: {
      true: 'They ask for a person: a human, the team, a call, someone real, or say they don\'t want the AI, or accept an earlier answer\'s offer to connect them with someone ("yes", "sure", "please do")',
      false: "They ask a question, report a problem or reply to an answer, however frustrated, without asking for a person",
    },
  },
  reply: {
    type: "noul" as const,
    instructions:
      "Does the latest message need a reply: a question, a problem, a request or something left open? Thanks, an acknowledgement (\"ok\", \"got it\", \"that worked\") or a greeting alone needs none.",
    criteria: {
      true: "It needs a reply: it asks, reports, requests or leaves something open",
      false: "It needs none: only thanks, an acknowledgement or a greeting",
    },
  },
};

/**
 * The decision model on the user's latest message, before the docs are searched: does it ask for a person, and does it
 * need a reply at all? Throws where the model fails.
 */
export async function readMessage(state: { message: string; earlier: Turn[] }, meter: Meter): Promise<{ person: boolean; needsReply: boolean }> {
  const answers = await decide({ ...state, message: newest(state.message) }, PERSON, { meter, timeoutMs: 15_000 });
  const [person, reply] = [answers.person as { noul: number }, answers.reply as { noul: number }];
  return { person: person.noul >= PERSON_AT, needsReply: reply.noul >= REPLY_AT };
}

type Message = { id: string; author: "USER" | "TEAM" | "AI"; body: string; channel: MessageChannel; createdAt: Date; handedOverAt: Date | null };

/** The question (the user's messages since the last reply) and the turns before it, from the conversation's messages, oldest first. */
function turnsOf(messages: Message[]): { question: string; earlier: Turn[] } {
  const lastReply = messages.findLastIndex((message) => message.author !== "USER");
  const question = newest(
    messages
      .slice(lastReply + 1)
      .map((message) => message.body)
      .join("\n\n"),
  );
  const earlier: Turn[] = [];
  let asked: string[] = [];
  for (const message of messages.slice(0, lastReply + 1)) {
    if (message.author === "USER") {
      asked.push(message.body);
    } else if (asked.length > 0) {
      earlier.push({ question: newest(asked.join("\n\n")), answer: message.body });
      asked = [];
    }
  }
  return { question, earlier: earlier.slice(-MAX_EARLIER_TURNS) };
}

/** What a turn came to. */
export type TurnOutcome = "answered" | "handed_over" | "kept" | "dropped" | "nothing";

/**
 * The turn, if one is due (`pathDueAt`): claimed first (`pathDueAt` pushed on, from the value read, so one turn runs at a
 * time and the job leaves a running one alone), then answered or handed over. Never throws: a turn that fails is left
 * due, for the inbox-due job, which hands it over once it's 10 minutes old.
 */
export async function runAiTurn(conversationId: string): Promise<TurnOutcome> {
  try {
    return await turn(conversationId);
  } catch (error) {
    log.error("The AI's turn in a conversation failed", { conversationId, error });
    return "nothing";
  }
}

async function turn(conversationId: string): Promise<TurnOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      projectId: true,
      number: true,
      pathDueAt: true,
      spamHeldAt: true,
      spam: true,
      handledBy: true,
      userId: true,
      messages: {
        // Tuti's own lines (W8's notes, before W16) are nobody's turn.
        where: { note: false, author: { in: ["USER", "TEAM", "AI"] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MESSAGES_READ,
        select: { id: true, author: true, body: true, channel: true, createdAt: true, handedOverAt: true },
      },
    },
  });
  // Held by the spam filter (its `pathDueAt`), or nothing due.
  if (!conversation?.pathDueAt || conversation.spamHeldAt) {
    return "nothing";
  }
  const { projectId } = conversation;
  // Only a turn that's due or about to be (a message's), never a running turn's lease: that turn has it.
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, pathDueAt: { equals: conversation.pathDueAt, lte: new Date(Date.now() + AI_TURN_DUE_MS) }, spamHeldAt: null },
    data: { pathDueAt: new Date(Date.now() + AI_TURN_LEASE_MS) },
  });
  if (count === 0) {
    // Another turn has it, or its work changed meanwhile.
    return "nothing";
  }
  const messages = conversation.messages.reverse() as Message[];
  const latest = messages.findLast((message) => message.author === "USER");
  // Nothing left to answer: settled where it's still the turn's to settle (taken over, answered, handed over).
  if (!latest || latest !== messages.at(-1) || latest.handedOverAt || conversation.handledBy !== "AI" || conversation.spam) {
    await settle(conversationId, latest?.id ?? null);
    return "nothing";
  }
  const { question, earlier } = turnsOf(messages);
  const handTo = async (reason: HandoverReason, summary = true): Promise<TurnOutcome> => {
    const note = summary
      ? await summarize(projectId, { question, askedBefore: earlier.map((t) => t.question), answer: null, notHelpful: false, note: null }, SUMMARY_TIMEOUT_MS)
      : null;
    const handed = await handOverAndTell(projectId, { id: conversationId, number: conversation.number }, latest.id, reason, { onlyFromAi: true, onlyIfLatest: true, note });
    return handed === null ? "dropped" : handed.handedOver ? "handed_over" : "kept";
  };
  if (Date.now() - latest.createdAt.getTime() > AI_TURN_GIVE_UP_MS) {
    return handTo("ai_off");
  }
  const automated = await prisma.conversationMessage.count({ where: { conversationId, author: "AI", note: false, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } } });
  if (automated >= AUTOMATED_REPLIES_PER_HOUR) {
    return handTo("too_many_replies", false);
  }
  const reader = await readerToSend(projectId, conversation.userId);
  if (reader === false || !(await aiAvailable(projectId))) {
    return handTo("ai_off");
  }
  // Asked before the docs are searched, where the server has a decision model; else the answer model says so.
  let askPerson = !decisionsAvailable();
  if (!askPerson) {
    const read = await aiFor(projectId, "answers")
      .then(({ meter }) => readMessage({ message: question, earlier }, meter))
      .catch((error: unknown) => {
        log.warn("Reading a user's message for the AI's turn failed: the answer model says", { projectId, conversationId, error });
        return null;
      });
    if (read?.person) {
      return handTo("user_asked");
    }
    if (read && !read.needsReply) {
      // Thanks, "ok", a lone "hi": nothing to answer or hand over. The AI keeps it; their next message gets a turn.
      await settle(conversationId, latest.id);
      return "nothing";
    }
    askPerson = read === null;
  }
  const follows = await prisma.docsQuestion.findFirst({ where: { projectId, conversationId, source: "INBOX" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const answer = await answerTurn(projectId, {
    // Its user, so Reporting names them; someone Tuti doesn't know by the conversation.
    askerId: conversation.userId ?? conversationId,
    question,
    source: "INBOX",
    reader,
    earlier,
    followsId: follows?.id ?? null,
    conversationId,
    askPerson,
  }).catch((error: unknown) => {
    // Past the hourly limits (429), the database: unavailable.
    log.warn("The AI's answer in a conversation failed", { projectId, conversationId, error });
    return null;
  });
  if (answer?.person) {
    return handTo("user_asked");
  }
  if (!answer || answer.status !== "answered" || !answer.answer) {
    return handTo(answer?.status === "no_answer" ? "no_answer" : answer?.status === "off_limits" ? "off_limits" : "ai_off");
  }
  const sources = answer.sources.map((source) => (source.url ? `${source.title} (${source.url})` : source.title));
  const body = sources.length > 0 ? `${answer.answer}\n\nSources: ${sources.join(", ")}` : answer.answer;
  return (await post(projectId, conversationId, latest, body)) ? "answered" : "dropped";
}

/**
 * Writes the AI's answer to `latest`, checked again under the conversation's lock: only while the AI has it, `latest` is
 * still the user's newest message (a newer one's turn answers both) and nothing answered or handed it over meanwhile.
 */
async function post(projectId: string, conversationId: string, latest: Message, body: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [conversation] = await tx.$queryRaw<
      { spam: boolean; spamHeldAt: Date | null; handledBy: "AI" | "TEAM"; number: number; userId: string | null; visitorHash: string | null; email: string | null }[]
    >`
      SELECT "spam", "spamHeldAt", "handledBy", "number", "userId", "visitorHash", "email" FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
    if (!conversation || conversation.spamHeldAt) {
      return false;
    }
    const newest = await newestFromUser(tx, conversationId);
    if (newest?.id !== latest.id) {
      return false;
    }
    const answered = await tx.conversationMessage.count({ where: { conversationId, author: "AI", requestId: latest.id } });
    if (conversation.spam || conversation.handledBy !== "AI" || newest.handedOverAt || answered > 0 || (await teamRepliedSince(tx, conversationId, newest))) {
      await tx.conversation.update({ where: { id: conversationId }, data: { pathDueAt: null } });
      return false;
    }
    const [{ last }] = await tx.$queryRaw<[{ last: Date | null }]>`
      SELECT MAX("createdAt") AS last FROM "conversation_message" WHERE "conversationId" = ${conversationId}`;
    const at = new Date(Math.max(Date.now(), last ? last.getTime() + 1 : 0));
    // As the set reply is written: it answers nobody on the team's side, so the conversation's status and wait stay.
    await tx.conversationMessage.create({
      data: { projectId, conversationId, author: "AI", authorId: null, channel: latest.channel, body, requestId: latest.id, createdAt: at },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at, activeAt: at, pathDueAt: null } });
    await notifyInbox(tx, { projectId, conversationId, number: conversation.number, userId: conversation.userId, visitorHash: conversation.visitorHash, email: conversation.email });
    return true;
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The user's newest message in a conversation. */
export const newestFromUser = (tx: Tx, conversationId: string) =>
  tx.conversationMessage.findFirst({
    where: { conversationId, author: "USER", note: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, handedOverAt: true },
  });

/**
 * Whether a teammate has replied (not a note) since the user's message, by the order messages are read in ((createdAt,
 * id)): a turn for it is over, whoever has the conversation now (taken over, replied to and handed back meanwhile).
 */
export async function teamRepliedSince(tx: Tx, conversationId: string, message: { id: string; createdAt: Date }): Promise<boolean> {
  const replied = await tx.conversationMessage.count({
    where: {
      conversationId,
      author: "TEAM",
      note: false,
      OR: [{ createdAt: { gt: message.createdAt } }, { createdAt: message.createdAt, id: { gt: message.id } }],
    },
  });
  return replied > 0;
}

/** Ends a turn with nothing to do: `pathDueAt` cleared, unless a newer message from the user (than `latest`) has its own turn due. */
async function settle(conversationId: string, latest: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
    const newest = await newestFromUser(tx, conversationId);
    if ((newest?.id ?? null) === latest) {
      await tx.conversation.updateMany({ where: { id: conversationId, spamHeldAt: null }, data: { pathDueAt: null } });
    }
  });
}
