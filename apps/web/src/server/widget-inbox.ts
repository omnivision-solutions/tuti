"use server";

import { type Prisma, prisma } from "@tuti/db";
import { replyRecipient, translationSettings } from "@tuti/jobs";
import { headers } from "next/headers";
import { z } from "zod";

import { rowLine } from "@/lib/format";
import { visitorHash } from "@/lib/visitor-session";

import { type AiAnswer, askPerson } from "./ai-turn";
import { attachmentLinks, checkUploads, claimUploads, startUpload, type Uploader } from "./attachments";
import { countEmailedLink } from "./email-link-limits";
import { OperationError } from "./operations/define";
import { inboxPath } from "./inbox-path";
import { addMessage, latestMessages, MAX_MESSAGE_LENGTH, startConversation } from "./operations/conversations";
import { notifyInboxNow } from "./live";
import { presenceKey, touchPresence } from "./presence";
import { arrivalOf, spamVerdict } from "./spam";
import { usualReplyMs } from "./widget-home";
import { newWidgetVisitor, unseenReplies, type WidgetAuth, type WidgetPerson, widgetPerson } from "./widget-person";

/**
 * Messages in the widget (docs/plan.md, Support inbox): someone's conversations with the
 * project's team, as server/widget-person.ts says who's here. Someone signed out gives an email
 * address that's never verified and never linked to a user.
 */

const NEW_CONVERSATIONS_PER_DAY = 20;
const MESSAGES_PER_MINUTE = 30;

type Result<T> = T | { error: string };

const body = z.string().trim().min(1, "Write something first").max(MAX_MESSAGE_LENGTH, "That's too long");
const email = z.email("Enter a valid email address").max(320);

type Person = WidgetPerson;

const person = widgetPerson;

/**
 * Their Messages is on screen: they're online for the team (server/presence.ts). The panel says so
 * when it's shown and every minute while it is; never while it's hidden, so closing it lets them go.
 */
export async function widgetHere(projectSlug: string, auth: WidgetAuth): Promise<object> {
  const who = await person(projectSlug, auth);
  if (who && (await touchPresence(who.projectId, presenceKey(who)))) {
    await notifyInboxNow({ projectId: who.projectId, conversationId: "", userId: who.userId, visitorHash: who.visitorHash });
  }
  return {};
}

const signInFirst = { error: "Sign in to message the team" };

/** Whether a visitor token is no good for a project whose Messages are on (not just off for now). */
async function visitorExpired(projectSlug: string, token: string) {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, supportInbox: true } });
  return !!project?.supportInbox && visitorHash(project.id, String(token)) === null;
}

/**
 * Their latest conversations, newest first, each with its latest message's first line (unless it says
 * the subject again), whether they wrote it (`yours`) or a person of the team did (`replied`: the AI's
 * answer before "Ask a person" isn't one), whether the team closed it, and how many of the team's
 * messages they haven't seen; and how many they haven't seen in all (`unseen`, for the launcher's dot, older
 * conversations included).
 */
export async function widgetConversations(projectSlug: string, auth: WidgetAuth): Promise<
  | Result<{
      conversations: {
        number: number;
        subject: string;
        line: string | undefined;
        yours: boolean;
        replied: boolean;
        closed: boolean;
        lastMessageAt: Date;
        unseen: number;
      }[];
      unseen: number;
    }>
  | { error: string; expired: true }
> {
  const who = await person(projectSlug, auth);
  if (!who) {
    // A visitor's token that's run out (or was never ours), as opposed to Messages being off: the panel forgets it.
    return auth.visitor && (await visitorExpired(projectSlug, auth.visitor)) ? { ...signInFirst, expired: true } : signInFirst;
  }
  const [rows, unseen] = await Promise.all([
    prisma.conversation.findMany({
      where: { projectId: who.projectId, ...who.where },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        lastMessageAt: true,
        _count: { select: { messages: { where: unseenReplies } } },
      },
    }),
    prisma.conversationMessage.count({ where: { ...unseenReplies, conversation: { projectId: who.projectId, ...who.where } } }),
  ]);
  const latest = await latestMessages(rows.map((row) => row.id));
  return {
    conversations: rows.map(({ id, status, _count, ...row }) => {
      const message = latest.get(id);
      return {
        ...row,
        closed: status === "CLOSED",
        line: message && rowLine(row.subject, message.body),
        yours: message?.author === "USER",
        replied: message?.author === "TEAM",
        unseen: _count.messages,
      };
    }),
    unseen,
  };
}


async function theirConversation(who: Person, number: number) {
  return prisma.conversation.findFirst({
    where: { projectId: who.projectId, ...who.where, number: Number(number) || 0 },
    select: { id: true, number: true, subject: true, status: true, spam: true, handledBy: true, pathDueAt: true, spamHeldAt: true },
  });
}

/**
 * One of their conversations' messages, oldest first; the team's are seen now that they're shown (unless the panel is hidden: `markSeen` false).
 * With whether it's waiting for the team's reply (`awaitingReply`: not closed, nor marked spam, which it never says), the address its replies are emailed to once they've left (`emailedTo`, replyRecipient's),
 * and how long the team usually takes to reply (`replyMs`, usualReplyMs). `withAi`: the AI has it (W13), `answering` while
 * its turn is due, and `askPerson` while Ask a person would hand it to the team (not once their latest message was).
 */
export async function widgetConversation(projectSlug: string, auth: WidgetAuth, number: number, markSeen = true): Promise<
  Result<{
    subject: string;
    awaitingReply: boolean;
    emailedTo: string | null;
    replyMs: number | null;
    withAi: boolean;
    answering: boolean;
    askPerson: boolean;
    /** The language the team writes in: a translated reply's original is in it. */
    teamLanguage: string;
    messages: {
      id: string;
      fromTeam: boolean;
      name: string | null;
      body: string;
      /**
       * The team's reply as they wrote it, where it was translated into the customer's language (docs/plan.md L22):
       * `body` is the translation, `language` its language. Null otherwise (their own messages' translations are the team's).
       */
      original: string | null;
      language: string | null;
      /** The AI's (not a person's on the team). */
      ai: boolean;
      /** The AI's answer from the docs: its sources, and the question its thumbs rate (`helpful`, as they rated it). */
      answer: { questionId: string; sources: AiAnswer["sources"]; helpful: boolean | null } | null;
      attachments: { id: string; filename: string; contentType: string; size: number; image: boolean; url: string | null }[];
      /** Imported from another tool, attachments that weren't brought across (shown, so no message is an empty bubble). */
      dropped: number;
      createdAt: Date;
    }[];
  }>
> {
  const who = await person(projectSlug, auth);
  const conversation = who && (await theirConversation(who, number));
  if (!conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  if (markSeen !== false) {
    await prisma.conversationMessage.updateMany({
      // The team's replies, and the AI's (a workflow's set reply): seen here, they aren't emailed.
      where: { conversationId: conversation.id, author: { in: ["TEAM", "AI"] }, note: false, seenAt: null },
      data: { seenAt: new Date() },
    });
  }
  const [messages, to, replyMs, { teamLanguage }] = await Promise.all([
    prisma.conversationMessage.findMany({
      // The team's notes are theirs alone.
      where: { conversationId: conversation.id, note: false },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        author: true,
        body: true,
        teamText: true,
        language: true,
        createdAt: true,
        authorUser: { select: { name: true } },
        attachments: { orderBy: { createdAt: "asc" }, select: { id: true, key: true, filename: true, contentType: true, size: true } },
        attachmentsDropped: true,
        importId: true,
        aiAnswer: true,
        handedOverAt: true,
      },
    }),
    // Where its replies are emailed: the reply job's own rules (replyRecipient), so it never promises one that won't go.
    replyRecipient(conversation.id).then((recipient) => ("to" in recipient ? recipient.to : null)),
    usualReplyMs(who.projectId),
    translationSettings(who.projectId),
  ]);
  // Their files and the team's, with links signed for a while (images shown, other files saved under their name).
  const answers = new Map(messages.flatMap((m) => (m.aiAnswer ? [[m.id, m.aiAnswer as AiAnswer] as const] : [])));
  const [links, rated] = await Promise.all([
    attachmentLinks(messages.flatMap((m) => m.attachments)).then((all) => new Map(all.map((a) => [a.id, a]))),
    prisma.docsQuestion
      .findMany({ where: { projectId: who.projectId, id: { in: [...answers.values()].map((a) => a.questionId) } }, select: { id: true, helpful: true } })
      .then((all) => new Map(all.map((q) => [q.id, q.helpful]))),
  ]);
  const withAi = conversation.handledBy === "AI" && !conversation.spam;
  return {
    subject: conversation.subject,
    awaitingReply: conversation.status !== "CLOSED" && !conversation.spam,
    emailedTo: to,
    replyMs,
    withAi,
    // Its turn is due (not the spam filter's hold): the AI is writing, or about to.
    answering: withAi && !!conversation.pathDueAt && !conversation.spamHeldAt && messages.at(-1)?.author === "USER",
    askPerson: withAi && messages.findLast((m) => m.author === "USER")?.handedOverAt === null,
    teamLanguage,
    messages: messages.map((m) => ({
      id: m.id,
      fromTeam: m.author !== "USER",
      name: m.author === "USER" ? null : (m.authorUser?.name ?? null),
      // An answer's text without its "Sources: …" line (the email's): the sources are listed under it.
      body: answers.get(m.id)?.text ?? m.body,
      ai: m.author === "AI",
      answer: answers.has(m.id) ? { questionId: answers.get(m.id)!.questionId, sources: answers.get(m.id)!.sources, helpful: rated.get(answers.get(m.id)!.questionId) ?? null } : null,
      original: m.author !== "USER" ? m.teamText : null,
      language: m.author !== "USER" && m.teamText !== null ? m.language : null,
      attachments: m.attachments.map((a) => links.get(a.id)!),
      // A received email's files dropped for want of storage are the team's to know (its server), not the user's.
      dropped: m.importId ? m.attachmentsDropped : 0,
      createdAt: m.createdAt,
    })),
  };
}

/** Their limits: a few new conversations a day, and messages no faster than a person types. */
async function overLimit(who: Person, starting: boolean) {
  const since = (ms: number) => ({ gte: new Date(Date.now() - ms) });
  if (starting) {
    const started = await prisma.conversation.count({ where: { projectId: who.projectId, ...who.where, createdAt: since(24 * 60 * 60_000) } });
    if (started >= NEW_CONVERSATIONS_PER_DAY) {
      return { error: "You've started a lot of conversations today. Try again tomorrow, or add to one you have." };
    }
  }
  const sent = await prisma.conversationMessage.count({
    where: { projectId: who.projectId, author: "USER", createdAt: since(60_000), conversation: who.where },
  });
  return sent >= MESSAGES_PER_MINUTE ? { error: "You're sending messages too fast. Wait a minute and try again." } : null;
}

/**
 * Starts a conversation with the team. Someone signed out gives their email first (so the team can
 * follow up once they've left) and gets a visitor token back, which shows them their conversations
 * from then on (`visitor`, new or the one they had).
 */
export async function widgetStartConversation(
  projectSlug: string,
  auth: WidgetAuth,
  text: string,
  address?: string,
  /** Files they uploaded for it (someone already known here: a new visitor gets their token with this message). */
  attachments: string[] = [],
): Promise<Result<{ number: number; visitor?: string }>> {
  const parsed = body.safeParse(text);
  let who = await person(projectSlug, auth);
  let visitor: string | undefined;
  let signedOutEmail: string | null = null;
  if (!who || who.visitorHash) {
    const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, supportInbox: true } });
    if (!project?.supportInbox || auth.token) {
      return signInFirst;
    }
    const given = email.safeParse(String(address ?? "").trim());
    if (!given.success) {
      return { error: given.error.issues[0]!.message };
    }
    signedOutEmail = given.data.toLowerCase();
    if (!who) {
      const fresh = newWidgetVisitor(project.id);
      visitor = fresh.token;
      who = fresh.person;
    }
  }
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const limited = await overLimit(who, true);
  if (limited) {
    return limited;
  }
  const files = visitor ? { uploads: [] } : await theirUploads(who, attachments);
  if ("error" in files) {
    return { error: files.error! };
  }
  if (signedOutEmail) {
    // Counted like emailed links (per address here, per visitor's IP and per project), as replies go to it by email.
    const counted = await countEmailedLink(who.projectId, signedOutEmail, await headers(), "team");
    if ("error" in counted || counted.id === null) {
      return { error: "error" in counted ? counted.error : "Too many messages from here in the last hour. Try again later." };
    }
  }
  let started;
  try {
    started = await startConversation(who.projectId, {
      userId: who.userId,
      email: signedOutEmail,
      visitorHash: who.visitorHash,
      body: parsed.data,
      origin: "WIDGET",
      channel: "WIDGET",
      // Checked again under the project's lock: starts at once can't all pass the check above.
      perDay: { where: who.where, max: NEW_CONVERSATIONS_PER_DAY },
      // The spam filter: someone the team blocked is blocked here too. A visitor's typed address proves nothing to it.
      filter: async (tx, first) => spamVerdict(tx, { ...(await arrivalOf(tx, who.projectId, who.userId)), ...first }),
      ...(files.uploads.length > 0 && { alongside: (tx, _conversationId, messageId) => claimUploads(tx, files.uploads, messageId) }),
    });
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  const { conversation, message } = started;
  // Filed as spam: theirs to see as any other (it never says so), and the path stops there: nobody is told.
  await inboxPath(who.projectId, { started: conversation, message });
  return { number: conversation.number, ...(visitor && { visitor }) };
}

/** Adds their message to one of their conversations (opening it again if it was waiting or closed). */
/** Whose their uploads are: their account's, or (signed out) their visitor token's. */
const uploader = (who: Person): Uploader => (who.userId ? { userId: who.userId } : { visitorHash: who.visitorHash! });

/** Checks the files they're sending (theirs, uploaded, within the limits); an error to show if not. */
async function theirUploads(who: Person, attachments: unknown) {
  const ids = Array.isArray(attachments) ? attachments.map(String).slice(0, 50) : [];
  if (ids.length === 0) {
    return { uploads: [] };
  }
  try {
    return { uploads: await checkUploads(who.projectId, uploader(who), ids) };
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Starts uploading a file they're attaching: where the panel PUTs it, and its id to send with their message. */
export async function widgetUploadAttachment(
  projectSlug: string,
  auth: WidgetAuth,
  file: { filename: string; contentType: string; size: number },
): Promise<Result<{ id: string; contentType: string; uploadUrl: string }>> {
  const who = await person(projectSlug, auth);
  if (!who) {
    return signInFirst;
  }
  const parsed = z.object({ filename: z.string().max(1000), contentType: z.string().max(200), size: z.number().int() }).safeParse(file);
  if (!parsed.success) {
    return { error: "That file can't be attached" };
  }
  try {
    return await startUpload(who.projectId, uploader(who), parsed.data);
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
}

export async function widgetSendMessage(projectSlug: string, auth: WidgetAuth, number: number, text: string, attachments: string[] = []): Promise<Result<object>> {
  const who = await person(projectSlug, auth);
  const conversation = who && (await theirConversation(who, number));
  if (!who || !conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  const parsed = body.safeParse(text);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const limited = await overLimit(who, false);
  if (limited) {
    return limited;
  }
  const files = await theirUploads(who, attachments);
  if ("error" in files) {
    return { error: files.error! };
  }
  let message;
  try {
    message = await addMessage(
      conversation.id,
      who.projectId,
      { author: "USER", authorId: who.userId, channel: "WIDGET", body: parsed.data },
      files.uploads.length > 0 ? (tx, messageId) => claimUploads(tx, files.uploads, messageId) : undefined,
    );
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  await inboxPath(who.projectId, { conversation, message });
  return {};
}

/** "Ask a person" under the AI's answers in one of their conversations (W13): the team has it from then on. */
export async function widgetAskPerson(projectSlug: string, auth: WidgetAuth, number: number): Promise<Result<object>> {
  const who = await person(projectSlug, auth);
  const conversation = who && (await theirConversation(who, number));
  if (!who || !conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  await askPerson(who.projectId, conversation);
  return {};
}
