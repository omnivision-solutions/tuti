import { type ConversationOrigin, type ConversationStatus, type MessageChannel, type Prisma, prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { emitEvent } from "../events";
import { notifyInbox } from "../live";
import { upsertProjectUser } from "../project-users";
import { type Actor, defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** The support inbox (docs/plan.md, Support inbox): conversations between a project's users and its team. */

export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
const toApiStatus = (status: ConversationStatus) => status.toLowerCase() as (typeof CONVERSATION_STATUSES)[number];

export const MAX_MESSAGE_LENGTH = 10_000;
const MAX_SUBJECT_LENGTH = 200;

export const conversationNumber = z.coerce.number().int().positive();
const body = z.string().trim().min(1, "Write something first").max(MAX_MESSAGE_LENGTH);

/** Someone from the project's app, matched by their id there (as with SSO), like `author` elsewhere. */
const appUser = z.object({
  id: z.string().min(1).max(255),
  name: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(320).optional(),
});

const conversationSelect = {
  id: true,
  number: true,
  subject: true,
  status: true,
  origin: true,
  email: true,
  emailVerified: true,
  spam: true,
  lastMessageAt: true,
  waitingSince: true,
  createdAt: true,
  assignee: { select: { name: true, email: true } },
  user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;

const messageSelect = {
  id: true,
  author: true,
  channel: true,
  body: true,
  note: true,
  createdAt: true,
  authorUser: { select: { name: true } },
} satisfies Prisma.ConversationMessageSelect;

type MessageRow = Prisma.ConversationMessageGetPayload<{ select: typeof messageSelect }>;

/**
 * Who a conversation is with: someone Tuti knows (their id in your app when they came through SSO
 * or the API) or just an email. An SSO user's User.email is a placeholder, so their app's email shows.
 */
export function conversationPerson(row: Pick<ConversationRow, "user" | "email" | "emailVerified">) {
  if (row.user) {
    const sso = row.user.ssoIdentity;
    return { id: sso?.externalId ?? null, name: row.user.name, email: sso ? sso.email : row.user.email, verified: true };
  }
  return { id: null, name: null, email: row.email, verified: row.emailVerified };
}

function view(row: ConversationRow, slug: string) {
  return {
    number: row.number,
    subject: row.subject,
    status: toApiStatus(row.status),
    origin: row.origin.toLowerCase(),
    user: conversationPerson(row),
    assignee: row.assignee,
    spam: row.spam,
    lastMessageAt: row.lastMessageAt,
    waitingSince: row.waitingSince,
    createdAt: row.createdAt,
    url: new URL(`/app/${slug}/inbox/${row.number}`, appUrl()).toString(),
  };
}

function messageView(row: MessageRow) {
  return {
    id: row.id,
    author: row.author.toLowerCase(),
    name: row.authorUser?.name ?? null,
    channel: row.channel.toLowerCase(),
    body: row.body,
    note: row.note,
    createdAt: row.createdAt,
  };
}

export async function findConversation(projectId: string, number: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { projectId_number: { projectId, number } },
    select: { ...conversationSelect, userId: true },
  });
  if (!conversation) {
    throw new OperationError(404, "not_found", `There's no conversation #${number}`);
  }
  return conversation;
}

/** The team member writing: the signed-in one, or for an API key, the one who created it. */
const teamMemberId = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** A team member by their email, for assigning. */
async function teamMemberByEmail(projectId: string, email: string) {
  const member = await prisma.teamMember.findFirst({
    where: { projectId, user: { email: email.toLowerCase() } },
    select: { userId: true },
  });
  if (!member) {
    throw new OperationError(404, "not_found", `${email} isn't on the project's team`);
  }
  return member.userId;
}

export const listConversations = defineOperation({
  name: "conversations.list",
  summary: "List conversations, latest message first; spam is left out unless asked for",
  method: "GET",
  path: "/conversations",
  scope: "read",
  access: "team",
  input: z.object({
    status: z.enum(CONVERSATION_STATUSES).optional(),
    /** A team member's email, or "none" for unassigned ones. */
    assignee: z.union([z.literal("none"), z.email()]).optional(),
    /** Someone from your app, by their id there. */
    user: z.string().min(1).max(255).optional(),
    spam: z.stringbool().default(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { status: "open", assignee: "none", limit: 10 },
  run: async ({ projectId }, input) => {
    const assigneeId =
      input.assignee === undefined || input.assignee === "none" ? null : await teamMemberByEmail(projectId, input.assignee);
    // ponytail: offset cursors, like posts.list.
    const rows = await prisma.conversation.findMany({
      where: {
        projectId,
        spam: input.spam,
        ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
        ...(input.assignee !== undefined && { assigneeId }),
        ...(input.user && { user: { ssoIdentity: { projectId, externalId: input.user } } }),
      },
      orderBy: [{ lastMessageAt: "desc" }, { number: "desc" }],
      skip: input.cursor,
      take: input.limit + 1,
      select: conversationSelect,
    });
    const slug = await projectSlug(projectId);
    return {
      conversations: rows.slice(0, input.limit).map((row) => view(row, slug)),
      nextCursor: rows.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getConversation = defineOperation({
  name: "conversations.get",
  summary: "Get a conversation by its number, with its messages, oldest first",
  method: "GET",
  path: "/conversations/{number}",
  scope: "read",
  access: "team",
  input: z.object({ number: conversationNumber }),
  run: async ({ projectId }, { number }) => {
    const conversation = await findConversation(projectId, number);
    const messages = await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      select: messageSelect,
    });
    return { ...view(conversation, await projectSlug(projectId)), messages: messages.map(messageView) };
  },
});

/** A subject from the first line of the first message, when none is given. */
const subjectFrom = (text: string) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

export const createConversation = defineOperation({
  name: "conversations.create",
  summary: "Start a conversation from someone in your app (`user`, by their id there) or an email address, with their first message",
  method: "POST",
  path: "/conversations",
  scope: "write",
  access: "team",
  input: z
    .object({
      user: appUser.optional(),
      email: z.email().max(320).optional(),
      subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH).optional(),
      body,
    })
    .refine((input) => (input.user === undefined) !== (input.email === undefined), "Send either a user or an email")
    .meta({ oneOf: [{ required: ["user"] }, { required: ["email"] }] }),
  example: {
    user: { id: "user-42", name: "Sam", email: "sam@example.com" },
    subject: "Can't export to CSV",
    body: "The export button does nothing on the reports page.",
  },
  run: async ({ projectId }, input) => {
    const userId = input.user
      ? await upsertProjectUser(projectId, input.user.id, { name: input.user.name, email: input.user.email })
      : null;
    const { conversation, message } = await startConversation(projectId, {
      userId,
      email: input.email ?? null,
      subject: input.subject,
      body: input.body,
      origin: "API",
      channel: "API",
    });
    return announceConversation(projectId, conversation, message);
  },
});

/** Emails the team about the user's message (packages/jobs, conversation-message); never fails or holds up the request. */
async function tellTeam(messageId: string) {
  try {
    await enqueue("conversationMessage", { messageId });
  } catch (error) {
    log.error("Enqueueing the team's email about a message failed", { error, messageId });
  }
}

/** A new conversation as the API shows it, told to the project's webhooks and team. */
export async function announceConversation(projectId: string, conversation: ConversationRow, message: MessageRow) {
  const result = { ...view(conversation, await projectSlug(projectId)), messages: [messageView(message)] };
  await emitEvent(projectId, "conversation.created", result);
  await tellTeam(message.id);
  return result;
}

/** A message from the user, told to the project's webhooks and team (the team's own replies aren't, so they don't echo back). */
export async function announceUserMessage(projectId: string, number: number, message: MessageRow) {
  const result = messageView(message);
  await emitEvent(projectId, "conversation.message_created", { conversation: number, message: result });
  await tellTeam(message.id);
  return result;
}

/** A new conversation, numbered in the project, with the user's first message: open, and waiting on the team from now. */
export async function startConversation(
  projectId: string,
  start: {
    userId: string | null;
    email: string | null;
    /** A signed-out visitor's, in the widget (lib/visitor-session.ts). */
    visitorHash?: string | null;
    subject?: string;
    body: string;
    origin: ConversationOrigin;
    channel: MessageChannel;
    /** Messages after the user's first, oldest first: an AI answer and the AI's summary as a note, for an escalated question. */
    then?: { author: "AI"; body: string; note?: boolean }[];
    /** Refused (429) when the conversations `where` matches started this many in the last day: checked under the lock, so starts at once can't all pass. */
    perDay?: { where: Prisma.ConversationWhereInput; max: number };
  },
) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Locks the project row, so concurrent conversations get distinct numbers (and limits hold).
    const { conversationCount: number } = await tx.project.update({
      where: { id: projectId },
      data: { conversationCount: { increment: 1 } },
      select: { conversationCount: true },
    });
    if (start.perDay) {
      const started = await tx.conversation.count({
        where: { ...start.perDay.where, projectId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      });
      if (started >= start.perDay.max) {
        throw new OperationError(429, "rate_limited", "You've started a lot of conversations today. Try again tomorrow, or add to one you have.");
      }
    }
    const conversation = await tx.conversation.create({
      data: {
        projectId,
        number,
        subject: start.subject ?? subjectFrom(start.body),
        origin: start.origin,
        userId: start.userId,
        email: start.email?.toLowerCase() ?? null,
        visitorHash: start.visitorHash ?? null,
        lastMessageAt: now,
        waitingSince: now,
      },
      select: conversationSelect,
    });
    const message = await tx.conversationMessage.create({
      data: { projectId, conversationId: conversation.id, author: "USER", authorId: start.userId, channel: start.channel, body: start.body, createdAt: now },
      select: messageSelect,
    });
    // A millisecond apart, so they read in order.
    await tx.conversationMessage.createMany({
      data: (start.then ?? []).map((next, i) => ({
        projectId,
        conversationId: conversation.id,
        author: next.author,
        channel: start.channel,
        body: next.body,
        note: next.note ?? false,
        createdAt: new Date(now.getTime() + i + 1),
      })),
    });
    await notifyInbox(tx, { projectId, conversationId: conversation.id, userId: start.userId, visitorHash: start.visitorHash ?? null });
    return { conversation, message };
  });
}

/**
 * Adds a message and moves the conversation on: the team replying leaves it Waiting (on the user),
 * the user writing opens it again and keeps how long they've been waiting from their oldest unanswered message.
 */
export async function addMessage(
  conversationId: string,
  projectId: string,
  message: { author: "USER" | "TEAM"; authorId: string | null; channel: "API" | "APP" | "WIDGET" | "EMAIL"; body: string },
) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const created = await tx.conversationMessage.create({
      data: { projectId, conversationId, ...message, createdAt: now },
      select: messageSelect,
    });
    const whose = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { userId: true, visitorHash: true } });
    await notifyInbox(tx, { projectId, conversationId, ...whose });
    if (message.author === "TEAM") {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { status: "WAITING", waitingSince: null, lastMessageAt: now },
      });
    } else {
      // In SQL, so two messages at once keep the older waitingSince.
      await tx.$executeRaw`UPDATE "conversation" SET "status" = 'OPEN', "waitingSince" = COALESCE("waitingSince", ${now}), "lastMessageAt" = ${now}, "updatedAt" = ${now} WHERE "id" = ${conversationId}`;
    }
    return created;
  });
}

export const replyToConversation = defineOperation({
  name: "conversations.reply",
  summary: "Reply in a conversation as the team, or write as its user (`author`, by their id in your app)",
  method: "POST",
  path: "/conversations/{number}/messages",
  scope: "write",
  access: "team",
  input: z.object({ number: conversationNumber, body, author: appUser.pick({ id: true }).optional() }),
  example: { body: "Thanks, Sam! A fix is on its way." },
  run: async ({ actor, projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    let message: MessageRow;
    if (input.author) {
      if (actor.kind === "user") {
        throw new OperationError(403, "forbidden", "Only API keys can write on someone's behalf");
      }
      const identity = await prisma.ssoIdentity.findUnique({
        where: { projectId_externalId: { projectId, externalId: input.author.id } },
        select: { userId: true },
      });
      if (!identity || identity.userId !== conversation.userId) {
        throw new OperationError(403, "forbidden", "Only the conversation's user can write as its user");
      }
      message = await addMessage(conversation.id, projectId, { author: "USER", authorId: identity.userId, channel: "API", body: input.body });
    } else {
      message = await addMessage(conversation.id, projectId, {
        author: "TEAM",
        authorId: teamMemberId(actor),
        channel: actor.kind === "user" ? "APP" : "API",
        body: input.body,
      });
    }
    return message.author === "USER" ? announceUserMessage(projectId, conversation.number, message) : messageView(message);
  },
});

export const updateConversation = defineOperation({
  name: "conversations.update",
  summary: "Change a conversation's status, assign it to a team member (by email; null to unassign) or mark it as spam",
  method: "PATCH",
  path: "/conversations/{number}",
  scope: "write",
  access: "team",
  input: z
    .object({
      number: conversationNumber,
      status: z.enum(CONVERSATION_STATUSES).optional(),
      assignee: z.email().nullable().optional(),
      spam: z.boolean().optional(),
    })
    .refine((input) => input.status !== undefined || input.assignee !== undefined || input.spam !== undefined, "Send a status, an assignee or spam")
    .meta({ anyOf: [{ required: ["status"] }, { required: ["assignee"] }, { required: ["spam"] }] }),
  example: { status: "closed" },
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const assigneeId = input.assignee ? await teamMemberByEmail(projectId, input.assignee) : input.assignee;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
          ...(assigneeId !== undefined && { assigneeId }),
          ...(input.spam !== undefined && { spam: input.spam }),
        },
        select: { ...conversationSelect, userId: true, visitorHash: true },
      });
      await notifyInbox(tx, { projectId, conversationId: row.id, userId: row.userId, visitorHash: row.visitorHash });
      return row;
    });
    return view(updated, await projectSlug(projectId));
  },
});
