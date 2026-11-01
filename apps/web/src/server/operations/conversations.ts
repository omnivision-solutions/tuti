import { type ConversationOrigin, type ConversationStatus, type MessageChannel, type Prisma, prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { appUrl } from "@/lib/hosts";

import { attachmentLinks, checkUploads, claimUploads } from "../attachments";
import { emitEvent } from "../events";
import { notifyInbox } from "../live";
import { upsertProjectUser } from "../project-users";
import { type Actor, defineOperation, OperationError } from "./define";
import { findPost, postNumber, projectSlug, toApiStatus as toPostStatus } from "./read";

/** The support inbox (docs/plan.md, Support inbox): conversations between a project's users and its team. */

export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
/** The statuses the team sets by hand; waiting is set by replying (the team spoke last). */
export const SETTABLE_STATUSES = ["open", "closed"] as const;
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
  snoozedUntil: true,
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
  attachments: { orderBy: { createdAt: "asc" }, select: { id: true, filename: true, contentType: true, size: true } },
  attachmentsDropped: true,
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
    /** Out of the inbox's views till then (null: not snoozed, or no longer; never closed or spam ones). */
    snoozedUntil: row.snoozedUntil && row.snoozedUntil > new Date() && row.status !== "CLOSED" && !row.spam ? row.snoozedUntil : null,
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
    /** The files it came with (kept in the media storage), and how many couldn't be kept (no storage). */
    attachments: row.attachments,
    attachmentsDropped: row.attachmentsDropped,
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

/**
 * Not snoozed: never, no longer (its time passed; the wake job opens it soon after), or closed or spam (done with,
 * whatever snooze a release from before left on it).
 */
export const awake = (now = new Date()): Prisma.ConversationWhereInput => ({
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }, { status: "CLOSED" }, { spam: true }],
});

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
  summary: "List conversations, latest message first; spam is left out unless asked for. `snoozed` true lists only those snoozed now, false leaves them out",
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
    /** Only those snoozed now (true), or none of them (false); either, unless given. */
    snoozed: z.stringbool().optional(),
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
        // With the status asked for, if any (each a condition of its own, so neither takes the other's place).
        ...(input.snoozed === true && { AND: [{ snoozedUntil: { gt: new Date() } }, { status: { not: "CLOSED" } }, { spam: false }] }),
        ...(input.snoozed === false && { AND: [awake()] }),
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
    // Each attachment with a link to it, signed for a while: images to show, other files saved under their name.
    const links = new Map(
      (
        await attachmentLinks(
          await prisma.conversationAttachment.findMany({
            where: { message: { conversationId: conversation.id } },
            select: { id: true, key: true, filename: true, contentType: true },
          }),
        )
      ).map((link) => [link.id, link.url]),
    );
    return {
      ...view(conversation, await projectSlug(projectId)),
      posts: await linkedPosts(conversation.id),
      messages: messages.map((message) => {
        const shown = messageView(message);
        return { ...shown, attachments: shown.attachments.map((a) => ({ ...a, url: links.get(a.id) ?? null })) };
      }),
    };
  },
});

/** A subject from the first line of the first message, when none is given. */
export const subjectFrom = (text: string) => {
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
    // The message is saved: the conversation-notices-resubmit cron finds it and queues it again.
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
    /** Mail that failed DMARC: it goes to Spam, and nobody is told. */
    spam?: boolean;
    /** The first message came by email. */
    received?: ReceivedEmail;
    /** More to write in the same transaction (a received email's status, its attachments), with the conversation's and its first message's ids. */
    alongside?: (tx: Prisma.TransactionClient, conversationId: string, messageId: string) => Promise<void>;
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
        spam: start.spam ?? false,
        lastMessageAt: now,
        waitingSince: now,
      },
      select: conversationSelect,
    });
    const message = await tx.conversationMessage.create({
      data: {
        projectId,
        conversationId: conversation.id,
        author: "USER",
        authorId: start.userId,
        channel: start.channel,
        body: start.body,
        ...start.received,
        createdAt: now,
      },
      select: messageSelect,
    });
    let first = message;
    if (start.alongside) {
      await start.alongside(tx, conversation.id, message.id);
      // What it wrote with the first message (a received email's attachments) is part of the message announced.
      first = await tx.conversationMessage.findUniqueOrThrow({ where: { id: message.id }, select: messageSelect });
    }
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
    return { conversation, message: first };
  });
}

/**
 * Adds a message and moves the conversation on: the team replying leaves it Waiting (on the user),
 * the user writing opens it again and keeps how long they've been waiting from their oldest unanswered message.
 */
/** What's kept of a message received by email (see ConversationMessage). */
export type ReceivedEmail = { emailMessageId: string | null; fromAddress: string | null; original: string | null; attachmentsDropped?: number };

export async function addMessage(
  conversationId: string,
  projectId: string,
  message: { author: "USER" | "TEAM" | "AI"; authorId: string | null; channel: "API" | "APP" | "WIDGET" | "EMAIL"; body: string; note?: boolean } & Partial<ReceivedEmail>,
  /** More to write in the same transaction (a received email's status), with the new message's id. */
  alongside?: (tx: Prisma.TransactionClient, messageId: string) => Promise<void>,
) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const created = await tx.conversationMessage.create({
      data: { projectId, conversationId, ...message, createdAt: now },
      select: messageSelect,
    });
    let written = created;
    if (alongside) {
      await alongside(tx, created.id);
      // What it wrote with it (a received email's attachments) is part of the message the caller announces.
      written = await tx.conversationMessage.findUniqueOrThrow({ where: { id: created.id }, select: messageSelect });
    }
    const whose = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { userId: true, visitorHash: true } });
    await notifyInbox(tx, { projectId, conversationId, ...whose });
    if (message.note) {
      // The team's note to itself: nobody replied, and the user mustn't see anything move (their list is by lastMessageAt).
      return written;
    }
    if (message.author === "TEAM") {
      // A snooze whose time has passed (the wake job not there yet) ends with the team's reply: it's been seen to.
      await tx.$executeRaw`UPDATE "conversation" SET "status" = 'WAITING', "waitingSince" = NULL, "lastMessageAt" = ${now},
        "snoozedUntil" = CASE WHEN "snoozedUntil" <= ${now} THEN NULL ELSE "snoozedUntil" END, "updatedAt" = ${now} WHERE "id" = ${conversationId}`;
    } else {
      // In SQL, so two messages at once keep the older waitingSince.
      // The user writing wakes it if it's snoozed.
      await tx.$executeRaw`UPDATE "conversation" SET "status" = 'OPEN', "waitingSince" = COALESCE("waitingSince", ${now}), "lastMessageAt" = ${now}, "snoozedUntil" = NULL, "updatedAt" = ${now} WHERE "id" = ${conversationId}`;
    }
    return written;
  });
}

export const replyToConversation = defineOperation({
  name: "conversations.reply",
  summary: "Reply in a conversation as the team, write an internal note (`note`: only the team sees it, never sent), or write as its user (`author`, by their id in your app)",
  method: "POST",
  path: "/conversations/{number}/messages",
  scope: "write",
  access: "team",
  input: z.object({
    number: conversationNumber,
    body,
    author: appUser.pick({ id: true }).optional(),
    note: z.boolean().optional().describe("An internal note: only the team sees it; it isn't sent and doesn't change the status"),
    attachments: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe("Files uploaded for it in the app (their ids), sent with it: 10 MB each, 25 MB together"),
  }),
  example: { body: "Thanks, Sam! A fix is on its way." },
  run: async ({ actor, projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    let message: MessageRow;
    if (input.note && input.author) {
      throw new OperationError(400, "invalid_input", "Notes are the team's: write one without an author");
    }
    if (input.attachments?.length && (input.author || actor.kind !== "user")) {
      throw new OperationError(400, "invalid_input", "Attachments are uploaded and sent by a teammate in the app");
    }
    const uploads = input.attachments?.length && actor.kind === "user" ? await checkUploads(projectId, { userId: actor.userId }, input.attachments) : [];
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
      message = await addMessage(
        conversation.id,
        projectId,
        {
          author: "TEAM",
          authorId: teamMemberId(actor),
          channel: actor.kind === "user" ? "APP" : "API",
          body: input.body,
          note: input.note ?? false,
        },
        uploads.length > 0 ? (tx, messageId) => claimUploads(tx, uploads, messageId) : undefined,
      );
    }
    return message.author === "USER" ? announceUserMessage(projectId, conversation.number, message) : messageView(message);
  },
});

export const updateConversation = defineOperation({
  name: "conversations.update",
  summary:
    "Change a conversation's status, assign it to a team member (by email; null to unassign), mark it as spam, or snooze it till a time to come (`snoozedUntil`, up to a year; null wakes it): out of the inbox's views till then, or till the user writes, and open again after",
  method: "PATCH",
  path: "/conversations/{number}",
  scope: "write",
  access: "team",
  input: z
    .object({
      number: conversationNumber,
      status: z.enum(SETTABLE_STATUSES).optional(),
      assignee: z.email().nullable().optional(),
      spam: z.boolean().optional(),
      snoozedUntil: z.iso
        .datetime({ offset: true })
        .transform((at) => new Date(at))
        .refine((at) => at > new Date() && at.getTime() - Date.now() <= 366 * 86_400_000, "Snooze it till a time in the next year")
        .nullable()
        .optional(),
    })
    .refine(
      (input) => input.status !== undefined || input.assignee !== undefined || input.spam !== undefined || input.snoozedUntil !== undefined,
      "Send a status, an assignee, spam or snoozedUntil",
    )
    .meta({ anyOf: [{ required: ["status"] }, { required: ["assignee"] }, { required: ["spam"] }, { required: ["snoozedUntil"] }] }),
  example: { status: "closed" },
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    const assigneeId = input.assignee ? await teamMemberByEmail(projectId, input.assignee) : input.assignee;
    const updated = await prisma.$transaction(async (tx) => {
      // The row as it is now, held till this commits: what's decided on it isn't undone by a change in between (a close,
      // a reply, spam). NO KEY: a message being added (its foreign key's share lock) doesn't wait for it, nor it for that.
      const [held] = await tx.$queryRaw<{ status: ConversationStatus; spam: boolean; snoozedUntil: Date | null }[]>`
        SELECT "status", "spam", "snoozedUntil" FROM "conversation" WHERE "id" = ${conversation.id} FOR NO KEY UPDATE`;
      // A closed one, or spam, is done with: nothing to snooze (open it first, or in the same change).
      if (input.snoozedUntil && (input.status ?? toApiStatus(held!.status)) === "closed") {
        throw new OperationError(409, "closed", "A closed conversation isn't snoozed");
      }
      if (input.snoozedUntil && (input.spam ?? held!.spam)) {
        throw new OperationError(409, "spam", "Spam isn't snoozed");
      }
      // Woken by hand, as when its time passes: open again (unless it's being closed, or is or becomes spam). A snooze
      // whose time has just passed too, before the wake job got to it: clearing it here, it would never open otherwise.
      const waking = input.snoozedUntil === null && !!held?.snoozedUntil && !input.status && !(input.spam ?? held.spam) && held.status !== "CLOSED";
      const row = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          ...(input.status && { status: input.status.toUpperCase() as ConversationStatus }),
          ...(waking && { status: "OPEN" as const }),
          ...(assigneeId !== undefined && { assigneeId }),
          ...(input.spam !== undefined && { spam: input.spam }),
          ...(input.snoozedUntil !== undefined && { snoozedUntil: input.snoozedUntil, snoozedAt: input.snoozedUntil && new Date() }),
          // Closed or spam is done with: a snooze no longer brings it back.
          ...((input.status === "closed" || input.spam === true) && input.snoozedUntil === undefined && { snoozedUntil: null }),
          // One left on it while it was closed or spam (by a release from before) doesn't come back with it.
          ...((held!.status === "CLOSED" || held!.spam) && input.snoozedUntil === undefined && { snoozedUntil: null }),
        },
        select: { ...conversationSelect, userId: true, visitorHash: true },
      });
      await notifyInbox(tx, { projectId, conversationId: row.id, userId: row.userId, visitorHash: row.visitorHash });
      return row;
    });
    return view(updated, await projectSlug(projectId));
  },
});

/** The posts a conversation is linked to, the first linked first. */
async function linkedPosts(conversationId: string) {
  const links = await prisma.conversationPost.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { post: { select: { number: true, title: true, status: true } } },
  });
  return links.map(({ post }) => ({ number: post.number, title: post.title, status: toPostStatus(post.status) }));
}

export const linkConversationPost = defineOperation({
  name: "conversations.linkPost",
  summary: "Link a conversation to a post it's about; merging the post takes the link along",
  method: "POST",
  path: "/conversations/{number}/posts",
  scope: "write",
  access: "team",
  input: z.object({ number: conversationNumber, post: postNumber }),
  example: { post: 12 },
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    let post = await findPost(projectId, input.post);
    if (!post.duplicateOf) {
      // Only while it isn't merged: a merge locks its row first (mergePosts), so a link either lands before it
      // (and the merge moves it) or waits for it and finds it merged.
      const linked = await prisma.$executeRaw`
        INSERT INTO conversation_post ("conversationId", "postId")
        SELECT ${conversation.id}, id FROM post WHERE id = ${post.id} AND "duplicateOfId" IS NULL FOR SHARE
        ON CONFLICT ("conversationId", "postId") DO NOTHING`;
      if (linked === 0) {
        post = await findPost(projectId, input.post);
      }
    }
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", `#${post.number} was merged into #${post.duplicateOf.number}: link that one`);
    }
    return { posts: await linkedPosts(conversation.id) };
  },
});

export const unlinkConversationPost = defineOperation({
  name: "conversations.unlinkPost",
  summary: "Unlink a conversation from a post",
  method: "DELETE",
  path: "/conversations/{number}/posts/{post}",
  scope: "write",
  access: "team",
  input: z.object({ number: conversationNumber, post: postNumber }),
  run: async ({ projectId }, input) => {
    const conversation = await findConversation(projectId, input.number);
    // Waits for a merge of the post (which holds its row), so a link it moves isn't unlinked halfway.
    await prisma.$executeRaw`
      DELETE FROM conversation_post WHERE "conversationId" = ${conversation.id}
        AND "postId" = (SELECT id FROM post WHERE "projectId" = ${projectId} AND number = ${input.post} FOR SHARE)`;
    return { posts: await linkedPosts(conversation.id) };
  },
});
