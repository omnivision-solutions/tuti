"use server";

import { prisma } from "@tuti/db";
import { headers } from "next/headers";
import { z } from "zod";

import { countEmailedLink } from "./email-link-limits";
import { addMessage, announceConversation, announceUserMessage, MAX_MESSAGE_LENGTH, startConversation } from "./operations/conversations";
import { newWidgetVisitor, type WidgetAuth, type WidgetPerson, widgetPerson } from "./widget-person";

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

const signInFirst = { error: "Sign in to message the team" };

/**
 * Their latest conversations, each with how many of the team's messages they haven't seen, and how
 * many they haven't seen in all (`unseen`, for the launcher's dot, older conversations included).
 */
export async function widgetConversations(projectSlug: string, auth: WidgetAuth): Promise<
  Result<{ conversations: { number: number; subject: string; lastMessageAt: Date; unseen: number }[]; unseen: number }>
> {
  const who = await person(projectSlug, auth);
  if (!who) {
    return signInFirst;
  }
  const [rows, unseen] = await Promise.all([
    prisma.conversation.findMany({
      where: { projectId: who.projectId, ...who.where },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      select: {
        number: true,
        subject: true,
        lastMessageAt: true,
        _count: { select: { messages: { where: { author: "TEAM", seenAt: null } } } },
      },
    }),
    prisma.conversationMessage.count({ where: { author: "TEAM", seenAt: null, conversation: { projectId: who.projectId, ...who.where } } }),
  ]);
  return { conversations: rows.map(({ _count, ...row }) => ({ ...row, unseen: _count.messages })), unseen };
}

async function theirConversation(who: Person, number: number) {
  return prisma.conversation.findFirst({
    where: { projectId: who.projectId, ...who.where, number: Number(number) || 0 },
    select: { id: true, number: true, subject: true },
  });
}

/** One of their conversations' messages, oldest first; the team's are seen now that they're shown. */
export async function widgetConversation(projectSlug: string, auth: WidgetAuth, number: number): Promise<
  Result<{ subject: string; messages: { id: string; fromTeam: boolean; name: string | null; body: string; createdAt: Date }[] }>
> {
  const who = await person(projectSlug, auth);
  const conversation = who && (await theirConversation(who, number));
  if (!conversation) {
    return who ? { error: "Conversation not found" } : signInFirst;
  }
  await prisma.conversationMessage.updateMany({
    where: { conversationId: conversation.id, author: "TEAM", seenAt: null },
    data: { seenAt: new Date() },
  });
  const messages = await prisma.conversationMessage.findMany({
    // The team's notes are theirs alone.
    where: { conversationId: conversation.id, note: false },
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
  if (signedOutEmail) {
    // Counted like emailed links (per address, per visitor's IP and per project), as replies go to it by email.
    const counted = await countEmailedLink(who.projectId, signedOutEmail, await headers());
    if ("error" in counted || counted.id === null) {
      return { error: "error" in counted ? counted.error : "Too many messages from here in the last hour. Try again later." };
    }
  }
  const { conversation, message } = await startConversation(who.projectId, {
    userId: who.userId,
    email: signedOutEmail,
    visitorHash: who.visitorHash,
    body: parsed.data,
    origin: "WIDGET",
    channel: "WIDGET",
  });
  await announceConversation(who.projectId, conversation, message);
  return { number: conversation.number, ...(visitor && { visitor }) };
}

/** Adds their message to one of their conversations (opening it again if it was waiting or closed). */
export async function widgetSendMessage(projectSlug: string, auth: WidgetAuth, number: number, text: string): Promise<Result<object>> {
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
  const message = await addMessage(conversation.id, who.projectId, { author: "USER", authorId: who.userId, channel: "WIDGET", body: parsed.data });
  await announceUserMessage(who.projectId, conversation.number, message);
  return {};
}
