"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

import { widgetUser } from "@/lib/widget-session";

import { canActIn } from "./membership";
import { addMessage, announceConversation, announceUserMessage, MAX_MESSAGE_LENGTH, startConversation } from "./operations/conversations";
import { OperationError } from "./operations/define";
import { getSession } from "./session";

/**
 * Messages in the widget (docs/plan.md, Support inbox): the signed-in person's conversations
 * with the project's team. Only the panel's widget token from the page's current Tuti.identify
 * (lib/widget-session.ts), or the portal's own sign-in; never the reader cookie, which only
 * says who may read a private portal.
 */

const NEW_CONVERSATIONS_PER_DAY = 20;
const MESSAGES_PER_MINUTE = 30;

type Result<T> = T | { error: string };

const body = z.string().trim().min(1, "Write something first").max(MAX_MESSAGE_LENGTH, "That's too long");

/** Whose Messages these are: the project's inbox must be on, and the person signed in. */
async function person(projectSlug: string, token: string | null) {
  const project = await prisma.project.findUnique({ where: { slug: String(projectSlug) }, select: { id: true, supportInbox: true } });
  if (!project?.supportInbox) {
    return null;
  }
  if (token) {
    const userId = widgetUser(project.id, String(token));
    return userId ? { projectId: project.id, userId } : null;
  }
  const session = await getSession();
  return session && (await canActIn(session.user.id, project.id)) ? { projectId: project.id, userId: session.user.id } : null;
}

const signInFirst = { error: "Sign in to message the team" };

/**
 * Their latest conversations, each with how many of the team's messages they haven't seen, and how
 * many they haven't seen in all (`unseen`, for the launcher's dot, older conversations included).
 */
export async function widgetConversations(projectSlug: string, token: string | null): Promise<
  Result<{ conversations: { number: number; subject: string; lastMessageAt: Date; unseen: number }[]; unseen: number }>
> {
  const who = await person(projectSlug, token);
  if (!who) {
    return signInFirst;
  }
  const [rows, unseen] = await Promise.all([
    prisma.conversation.findMany({
      where: { projectId: who.projectId, userId: who.userId },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      select: {
        number: true,
        subject: true,
        lastMessageAt: true,
        _count: { select: { messages: { where: { author: "TEAM", seenAt: null } } } },
      },
    }),
    prisma.conversationMessage.count({ where: { author: "TEAM", seenAt: null, conversation: { projectId: who.projectId, userId: who.userId } } }),
  ]);
  return { conversations: rows.map(({ _count, ...row }) => ({ ...row, unseen: _count.messages })), unseen };
}

/** One of their conversations' messages, oldest first; the team's are seen now that they're shown. */
export async function widgetConversation(projectSlug: string, token: string | null, number: number): Promise<
  Result<{ subject: string; messages: { id: string; fromTeam: boolean; name: string | null; body: string; createdAt: Date }[] }>
> {
  const who = await person(projectSlug, token);
  const conversation =
    who &&
    (await prisma.conversation.findFirst({
      where: { projectId: who.projectId, userId: who.userId, number: Number(number) || 0 },
      select: { id: true, subject: true },
    }));
  if (!conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  await prisma.conversationMessage.updateMany({
    where: { conversationId: conversation.id, author: "TEAM", seenAt: null },
    data: { seenAt: new Date() },
  });
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, author: true, body: true, createdAt: true, authorUser: { select: { name: true } } },
  });
  return {
    subject: conversation.subject,
    messages: messages.map((m) => ({
      id: m.id,
      fromTeam: m.author !== "USER",
      name: m.author === "USER" ? null : (m.authorUser?.name ?? null),
      body: m.body,
      createdAt: m.createdAt,
    })),
  };
}

/** Their limits: a few new conversations a day, and messages no faster than a person types. */
async function overLimit(who: { projectId: string; userId: string }) {
  const since = (ms: number) => ({ gte: new Date(Date.now() - ms) });
  const sent = await prisma.conversationMessage.count({
    where: { projectId: who.projectId, authorId: who.userId, author: "USER", createdAt: since(60_000) },
  });
  return sent >= MESSAGES_PER_MINUTE ? { error: "You're sending messages too fast. Wait a minute and try again." } : null;
}

/** Starts a conversation with the team. */
export async function widgetStartConversation(projectSlug: string, token: string | null, text: string): Promise<Result<{ number: number }>> {
  const who = await person(projectSlug, token);
  if (!who) {
    return signInFirst;
  }
  const parsed = body.safeParse(text);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const limited = await overLimit(who);
  if (limited) {
    return limited;
  }
  let started;
  try {
    started = await startConversation(who.projectId, {
      userId: who.userId,
      email: null,
      body: parsed.data,
      origin: "WIDGET",
      channel: "WIDGET",
      perDay: { where: { userId: who.userId }, max: NEW_CONVERSATIONS_PER_DAY },
    });
  } catch (error) {
    if (error instanceof OperationError) {
      return { error: error.message };
    }
    throw error;
  }
  const { conversation, message } = started;
  await announceConversation(who.projectId, conversation, message);
  return { number: conversation.number };
}

/** Adds their message to one of their conversations (opening it again if it was waiting or closed). */
export async function widgetSendMessage(projectSlug: string, token: string | null, number: number, text: string): Promise<Result<object>> {
  const who = await person(projectSlug, token);
  const conversation =
    who &&
    (await prisma.conversation.findFirst({
      where: { projectId: who.projectId, userId: who.userId, number: Number(number) || 0 },
      select: { id: true, number: true },
    }));
  if (!who || !conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  const parsed = body.safeParse(text);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const limited = await overLimit(who);
  if (limited) {
    return limited;
  }
  const message = await addMessage(conversation.id, who.projectId, { author: "USER", authorId: who.userId, channel: "WIDGET", body: parsed.data });
  await announceUserMessage(who.projectId, conversation.number, message);
  return {};
}
