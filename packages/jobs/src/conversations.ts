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


/** How long a user's message is given to be told about the normal way before the cron steps in. */
const NOTICE_LATE_MS = 2 * 60 * 1000;
/** And how long the cron keeps trying: a notice a day late isn't worth sending. */
const NOTICE_RESUBMIT_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * Users' messages the team should have heard about but didn't, because queueing their notice failed
 * (the message was saved, the queue was down): each conversation's earliest one, queued again. Should
 * have: the conversation was last told about more than NOTIFY_EVERY_MS before it (a message inside
 * that wait is meant to tell nobody), it isn't spam, and someone on the team would get the email.
 */
export async function resubmitConversationNotices(_: JobInput<"resubmitConversationNotices">, log: JobLogger): Promise<JobResult> {
  if (!emailConfigured() || !process.env.APP_URL) {
    return { skipped: "email isn't set up" };
  }
  const now = Date.now();
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ON (m."conversationId") m."id"
    FROM "conversation_message" m
    JOIN "conversation" c ON c."id" = m."conversationId"
    WHERE m."author" = 'USER'
      AND NOT c."spam"
      AND m."createdAt" < ${new Date(now - NOTICE_LATE_MS)}
      AND m."createdAt" > ${new Date(now - NOTICE_RESUBMIT_FOR_MS)}
      AND (c."notifiedAt" IS NULL OR c."notifiedAt" < m."createdAt" - make_interval(secs => ${NOTIFY_EVERY_MS / 1000}))
      AND EXISTS (
        SELECT 1 FROM "team_member" t
        WHERE t."projectId" = c."projectId"
          AND (t."userId" = c."assigneeId" OR (c."assigneeId" IS NULL AND t."emailNewConversations"))
      )
    ORDER BY m."conversationId", m."createdAt" ASC
    LIMIT 500`;
  let queued = 0;
  for (const { id } of due) {
    try {
      await enqueue("conversationMessage", { messageId: id });
      queued++;
    } catch (error) {
      log.warn(`Couldn't queue the team's email about message ${id} again: ${String(error)}`);
    }
  }
  if (due.length > 0) {
    log.info(`Queued the team's email again for ${queued} of ${due.length} messages`);
  }
  return { found: due.length, queued };
}
