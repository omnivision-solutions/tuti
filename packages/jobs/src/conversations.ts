import { randomUUID } from "node:crypto";

import { INBOX_CHANNEL, prisma } from "@tuti/db";
import { conversationEmail, conversationReplyEmail, deliveredMessageId, emailConfigured, sendEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

import { enqueue, type JobLogger, type JobResult } from "./index";
import { sesTenantHeaders } from "./ses-tenant";

/** Tuti's loop header (apps/web lib/email-noise.ts): mail that comes back with it is known as ours. */
const LOOP_HEADER = "X-Tuti-Loop";

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

/**
 * Raw received emails (support inbox) still unread after 30 days, failed or stuck: their bodies go, the
 * rows stay. And SES's events a week on (SNS stops sending one again long before).
 */
export async function pruneInboundEmails(): Promise<JobResult> {
  const [{ count }, events] = await Promise.all([
    prisma.inboundEmail.updateMany({
      where: { raw: { not: null }, createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60_000) } },
      data: { raw: null },
    }),
    prisma.emailEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) } } }),
  ]);
  return { pruned: count, events: events.count };
}


/** A team message is emailed if it's still unseen this long after it was written. */
export const EMAIL_UNSEEN_AFTER_MS = 60_000;
/** A run that died holds its claim this long before another run takes the messages again. */
const CLAIM_FOR_MS = 10 * 60_000;
const MAX_TRIES = 3;
/** References keeps the thread's latest Message-IDs, as many as this. */
const MAX_REFERENCES = 20;

/** The team's messages still to email: unseen a minute on, not notes, not sent, with tries left, and nobody else sending them. */
const unsent = (now: Date) => ({
  author: "TEAM" as const,
  note: false,
  seenAt: null,
  emailStatus: null,
  emailAttempts: { lt: MAX_TRIES },
  createdAt: { lte: new Date(now.getTime() - EMAIL_UNSEEN_AFTER_MS) },
  OR: [{ emailClaimedAt: null }, { emailClaimedAt: { lt: new Date(now.getTime() - CLAIM_FOR_MS) } }],
  // On a server selling plans, only once the operator has approved the project (they wait till then).
  conversation: { spam: false, ...(plansEnabled() && { project: { emailApprovedAt: { not: null } } }) },
});

/**
 * Emails users the team's replies they haven't seen a minute after they were written (docs/plan.md,
 * Support inbox, "Reaching the user"): someone chatting in the widget sees them there and gets no
 * email; someone who wrote by email gets every reply. A conversation's unseen replies go in one email,
 * from its project's support address with the teammate's name, Reply-To the conversation's own
 * address. Each message is claimed before it's sent, so two runs send it once; a claim a run didn't
 * finish (it died) is taken again after 10 minutes, so a reply may rarely go twice but is never lost.
 */
export async function sendConversationReplies(_: JobInput<"sendConversationReplies">, log: JobLogger, now = new Date()): Promise<JobResult> {
  const domain = process.env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain || !emailConfigured()) {
    return { skipped: "support email isn't set up" };
  }
  const due = await prisma.conversationMessage.findMany({
    where: unsent(now),
    distinct: ["conversationId"],
    select: { conversationId: true },
    take: 100,
  });
  let sent = 0;
  for (const { conversationId } of due) {
    sent += (await sendReplies(conversationId, domain, now, log)) ? 1 : 0;
  }
  return { emails: sent };
}

async function sendReplies(conversationId: string, domain: string, now: Date, log: JobLogger): Promise<boolean> {
  const claimedAt = new Date();
  const { count } = await prisma.conversationMessage.updateMany({ where: { conversationId, ...unsent(now) }, data: { emailClaimedAt: claimedAt } });
  if (count === 0) {
    return false;
  }
  const [conversation, messages, thread] = await Promise.all([
    prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        projectId: true,
        userId: true,
        visitorHash: true,
        subject: true,
        replyToken: true,
        email: true,
        user: { select: { email: true, ssoIdentity: { select: { email: true } } } },
        project: { select: { name: true, mailSubdomain: { select: { subdomain: true } } } },
      },
    }),
    prisma.conversationMessage.findMany({
      where: { conversationId, emailClaimedAt: claimedAt },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        body: true,
        authorUser: { select: { name: true } },
        attachments: { orderBy: { createdAt: "asc" }, select: { key: true, filename: true, contentType: true } },
      },
    }),
    // The thread so far, for In-Reply-To and References: what they sent, and what we did.
    prisma.conversationMessage.findMany({
      where: { conversationId, OR: [{ emailMessageId: { not: null } }, { sentMessageId: { not: null } }] },
      orderBy: { createdAt: "desc" },
      take: MAX_REFERENCES,
      select: { emailMessageId: true, sentMessageId: true, deliveredMessageId: true },
    }),
  ]);
  const ids = messages.map((m) => m.id);
  // Open inbox pages show each message's delivery: tell them it changed (apps/web/src/server/live.ts).
  const notify = () =>
    prisma.$executeRaw`SELECT pg_notify(${INBOX_CHANNEL}, ${JSON.stringify({
      projectId: conversation.projectId,
      conversationId,
      userId: conversation.userId,
      visitorHash: conversation.visitorHash,
    })})`;
  const settle = (data: { emailStatus?: "SENT" | "FAILED"; emailError?: string | null; emailAttempts?: { increment: number } }) =>
    prisma.conversationMessage.updateMany({ where: { id: { in: ids }, emailClaimedAt: claimedAt }, data: { ...data, emailClaimedAt: null } });

  // Someone from the project's app has a placeholder account address: theirs is what the app gave.
  const to = conversation.user ? (conversation.user.ssoIdentity ? conversation.user.ssoIdentity.email : conversation.user.email) : conversation.email;
  const subdomain = conversation.project.mailSubdomain?.subdomain;
  if (!to || !subdomain) {
    await settle({ emailStatus: "FAILED", emailError: to ? "The project has no support address" : "They have no email address" });
    await notify();
    return false;
  }
  // They marked an email from the project as spam (SES's complaint): no more email to them from it.
  if (await prisma.emailBlock.findUnique({ where: { projectId_email: { projectId: conversation.projectId, email: to.toLowerCase() } } })) {
    await settle({ emailStatus: "FAILED", emailError: "They marked an email from you as spam, so replies reach them only in the widget" });
    await notify();
    return false;
  }
  const address = (token?: string) => `support${token ? `+${token}` : ""}@${subdomain}.${domain}`;
  const teammate = messages.at(-1)!.authorUser?.name;
  const from = `"${(teammate ? `${teammate} at ${conversation.project.name}` : conversation.project.name).replace(/["\\\r\n]/g, "")}" <${address()}>`;
  const messageId = `<${randomUUID()}@${subdomain}.${domain}>`;
  const references = thread
    .map((m) => m.deliveredMessageId ?? m.sentMessageId ?? m.emailMessageId)
    .filter((id): id is string => !!id)
    .reverse();
  const files = messages.flatMap((m) => m.attachments);
  let response: string | null;
  try {
    // The files go with it, as attachments (read here, so a storage failure is a try like any other).
    const storage = files.length > 0 ? mediaStorage() : null;
    if (files.length > 0 && !storage) {
      throw new Error("Its attachments can't be read: this server has no file storage");
    }
    const attachments = await Promise.all(files.map(async (f) => ({ filename: f.filename, contentType: f.contentType, content: await storage!.get(f.key) })));
    const tenant = await sesTenantHeaders(conversation.projectId, domain);
    response = await sendEmail({
      to,
      from,
      replyTo: address(conversation.replyToken),
      messageId,
      attachments,
      headers: {
        [LOOP_HEADER]: subdomain,
        ...tenant,
        ...(references.length > 0 && { "In-Reply-To": references.at(-1)!, References: references.join(" ") }),
      },
      ...conversationReplyEmail({
        projectName: conversation.project.name,
        subject: conversation.subject,
        messages: messages.map((m) => ({ name: m.authorUser?.name ?? conversation.project.name, body: m.body })),
      }),
    });
  } catch (error) {
    log.warn(`Emailing replies in a conversation failed: ${String(error)}`);
    await prisma.$transaction([
      settle({ emailAttempts: { increment: 1 }, emailError: String(error).slice(0, 500) }),
      // Out of tries: failed for good, shown on the message.
      prisma.conversationMessage.updateMany({ where: { id: { in: ids }, emailAttempts: { gte: MAX_TRIES } }, data: { emailStatus: "FAILED" } }),
    ]);
    await notify();
    return false;
  }
  await prisma.$transaction([
    settle({ emailStatus: "SENT", emailError: null }),
    // One Message-ID per email: the last message carries it, for replies that name it.
    prisma.conversationMessage.update({
      where: { id: ids.at(-1)! },
      data: { sentMessageId: messageId, deliveredMessageId: deliveredMessageId(response) },
    }),
  ]);
  await notify();
  return true;
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
