import { prisma } from "@tuti/db";
import { conversationEmail, emailConfigured, sendEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import type { JobLogger, JobResult } from "./index";

/** The team hears about a conversation at most this often, however many messages the user sends. */
export const NOTIFY_EVERY_MS = 10 * 60 * 1000;

/**
 * A user wrote in the support inbox (docs/plan.md, Support inbox): emails the conversation's
 * assignee, or with nobody assigned, every team member with "Email me new conversations" on. Spam
 * tells nobody. At most once every NOTIFY_EVERY_MS per conversation (claimed before sending, so two
 * runs at once send once; released if sending fails, so the retry sends).
 */
export async function conversationMessage({ messageId }: JobInput<"conversationMessage">, log: JobLogger): Promise<JobResult> {
  if (!emailConfigured() || !process.env.APP_URL) {
    return { skipped: "email isn't set up" };
  }
  const message = await prisma.conversationMessage.findUnique({
    where: { id: messageId },
    select: {
      author: true,
      body: true,
      createdAt: true,
      conversation: {
        select: {
          id: true,
          projectId: true,
          number: true,
          subject: true,
          spam: true,
          email: true,
          notifiedAt: true,
          assigneeId: true,
          user: { select: { name: true } },
          project: { select: { slug: true, name: true } },
        },
      },
    },
  });
  const conversation = message?.conversation;
  if (!message || !conversation || message.author !== "USER" || conversation.spam) {
    return { skipped: "nothing to tell" };
  }
  const team = await prisma.teamMember.findMany({
    where: {
      projectId: conversation.projectId,
      ...(conversation.assigneeId ? { userId: conversation.assigneeId } : { emailNewConversations: true }),
    },
    select: { user: { select: { email: true } } },
  });
  if (team.length === 0) {
    return { skipped: "nobody to tell" };
  }
  const previous = conversation.notifiedAt;
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversation.id, OR: [{ notifiedAt: null }, { notifiedAt: { lt: new Date(Date.now() - NOTIFY_EVERY_MS) } }] },
    data: { notifiedAt: new Date() },
  });
  if (count === 0) {
    return { skipped: "told recently" };
  }
  // The user's first message is the conversation's start.
  const earlier = await prisma.conversationMessage.count({
    where: { conversationId: conversation.id, author: "USER", createdAt: { lt: message.createdAt } },
  });
  const email = conversationEmail({
    projectName: conversation.project.name,
    from: conversation.user?.name ?? conversation.email ?? "Someone",
    isNew: earlier === 0,
    subject: conversation.subject,
    body: message.body,
    url: `${new URL(process.env.APP_URL).origin}/app/${conversation.project.slug}/inbox/${conversation.number}`,
    assigned: !!conversation.assigneeId,
  });
  try {
    for (const member of team) {
      await sendEmail({ to: member.user.email, ...email });
    }
  } catch (error) {
    await prisma.conversation.updateMany({ where: { id: conversation.id }, data: { notifiedAt: previous } });
    log.warn(`Emailing the team about conversation #${conversation.number} failed: ${String(error)}`);
    throw error;
  }
  return { emailed: team.length };
}
