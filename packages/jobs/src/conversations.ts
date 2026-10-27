import { prisma } from "@tuti/db";
import { conversationEmail, emailConfigured, sendEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import { enqueue, type JobLogger, type JobResult } from "./index";

/** The team hears about a conversation at most this often, however many messages the user sends. */
export const NOTIFY_EVERY_MS = 10 * 60 * 1000;

/**
 * A user wrote in the support inbox (docs/plan.md, Support inbox): emails the conversation's
 * assignee, or with nobody assigned, every team member with "Email me new conversations" on. Spam
 * tells nobody. At most once every NOTIFY_EVERY_MS per conversation (claimed before sending, so two
 * runs at once send once; released if sending fails, so the retry sends).
 */
export async function conversationMessage({ messageId, only }: JobInput<"conversationMessage">, log: JobLogger): Promise<JobResult> {
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
  const recipients = only ? team.filter((member) => only.includes(member.user.email)) : team;
  if (recipients.length === 0) {
    return { skipped: "nobody to tell" };
  }
  // Worked out before the claim, so nothing between claiming and sending can fail and leave the claim unsent.
  const earlier = await prisma.conversationMessage.count({
    where: { conversationId: conversation.id, author: "USER", createdAt: { lt: message.createdAt } },
  });
  const email = conversationEmail({
    projectName: conversation.project.name,
    from: conversation.user?.name ?? conversation.email ?? "Someone",
    // The user's first message is the conversation's start.
    isNew: earlier === 0,
    subject: conversation.subject,
    body: message.body,
    url: `${new URL(process.env.APP_URL).origin}/app/${conversation.project.slug}/inbox/${conversation.number}`,
    assigned: !!conversation.assigneeId,
  });
  if (only) {
    // A retry for the addresses the first run couldn't reach: each failure fails the job, for another try.
    await Promise.all(recipients.map((member) => sendEmail({ to: member.user.email, ...email })));
    return { emailed: recipients.length };
  }
  const previous = conversation.notifiedAt;
  const claimedAt = new Date();
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversation.id, OR: [{ notifiedAt: null }, { notifiedAt: { lt: new Date(claimedAt.getTime() - NOTIFY_EVERY_MS) } }] },
    data: { notifiedAt: claimedAt },
  });
  if (count === 0) {
    return { skipped: "told recently" };
  }
  // Each address on its own: one that's refused doesn't keep the others from hearing.
  const results = await Promise.allSettled(team.map((member) => sendEmail({ to: member.user.email, ...email })));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length === 0) {
    return { emailed: team.length };
  }
  log.warn(`Emailing the team about conversation #${conversation.number} failed for ${failed.length} of ${team.length}: ${String((failed[0] as PromiseRejectedResult).reason)}`);
  if (failed.length < team.length) {
    // Some heard: the others are tried again on their own, so nobody gets a second copy.
    const missed = team.filter((_, i) => results[i]!.status === "rejected").map((member) => member.user.email);
    try {
      await enqueue("conversationMessage", { messageId, only: missed });
    } catch (error) {
      // Their retry couldn't be queued: the whole job runs again instead. Those who heard may hear twice,
      // which beats someone never hearing.
      await prisma.conversation.updateMany({ where: { id: conversation.id, notifiedAt: claimedAt }, data: { notifiedAt: previous } });
      log.warn(`Couldn't queue emailing ${missed.length} of the team about conversation #${conversation.number} again: ${String(error)}`);
      throw error;
    }
    return { emailed: team.length - failed.length, retrying: failed.length };
  }
  // Nobody heard: the claim goes back for the retry, unless a newer run has claimed it since.
  await prisma.conversation.updateMany({ where: { id: conversation.id, notifiedAt: claimedAt }, data: { notifiedAt: previous } });
  throw (failed[0] as PromiseRejectedResult).reason;
}

