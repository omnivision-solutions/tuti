import { type EmailStatus, Prisma, prisma } from "@tuti/db";
import { deliveredMessageId, emailConfigured, emailPausedEmail, emailPausedTeamEmail, sendEmail } from "@tuti/email";
import { pauseIfOverLimits } from "@tuti/jobs";
import { log, plansEnabled } from "@tuti/shared";

import { resumeToken } from "@/lib/email-pause";
import { appUrl } from "@/lib/hosts";

import { portalAddress } from "./custom-domains";
import { notifyInbox } from "./live";

/**
 * What became of the support inbox's emails, from Amazon SES's events (docs/plan.md, Support inbox,
 * item 11; they come through SNS to /api/email/events). The email is found by the id SES gave it
 * when it was sent (kept as its Message-ID), and its status only moves forward: sent → delivered →
 * bounced or complained, so a late delivery never hides a bounce. A complaint also stops replies by
 * email to that address for the project. Each SNS message counts once.
 *
 * On a server selling plans, each project's email is counted too, by the project its tags name
 * (packages/jobs/src/ses-tenant.ts): what it sent, what bounced for good and what drew complaints;
 * a bounce or complaint that takes it over the limits pauses its email (packages/jobs/src/email-limits.ts).
 */
type SesEvent = {
  eventType?: string;
  mail?: { messageId?: string; timestamp?: string; tags?: Record<string, string[] | undefined> };
  bounce?: { bounceType?: string; bouncedRecipients?: { diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
};

/** Each status, and the ones it may follow. */
const FORWARD: Partial<Record<string, { status: EmailStatus; after: EmailStatus[] }>> = {
  Delivery: { status: "DELIVERED", after: ["SENT"] },
  Bounce: { status: "BOUNCED", after: ["SENT", "DELIVERED"] },
  Complaint: { status: "COMPLAINED", after: ["SENT", "DELIVERED", "BOUNCED"] },
};

/** An event for an email we can't find yet, this recent, is tried again: the send may not have saved SES's id yet. */
const UNSAVED_FOR_MS = 5 * 60_000;

class NotSavedYet extends Error {}

/** The project's count an event adds to, if any. */
function counted(event: SesEvent): { projectId: string; column: "sent" | "bounced" | "complained" } | null {
  const projectId = event.mail?.tags?.project?.[0];
  const column =
    event.eventType === "Send"
      ? "sent"
      : event.eventType === "Bounce" && event.bounce?.bounceType === "Permanent"
        ? "bounced"
        : event.eventType === "Complaint"
          ? "complained"
          : null;
  return plansEnabled() && projectId && column ? { projectId, column } : null;
}

/** False when SNS should try again later. */
export async function recordEmailEvent(snsMessageId: string, event: SesEvent, now = Date.now()): Promise<boolean> {
  const change = FORWARD[event.eventType ?? ""];
  const id = deliveredMessageId(`250 Ok ${event.mail?.messageId ?? ""}`);
  const count = counted(event);
  // Another of a project's emails (not a reply) never has a message to mark.
  const reply = !event.mail?.tags?.project || event.mail.tags.email?.[0] === "reply";
  if (!(change && id && reply) && !count) {
    return true;
  }
  let added = false;
  try {
    await prisma.$transaction(async (tx) => {
      added = (await tx.emailEvent.createMany({ data: [{ id: snsMessageId }], skipDuplicates: true })).count > 0;
      if (!added) {
        return;
      }
      if (count) {
        // On the day (UTC) the email was sent, so a bounce counts against that day's sends however
        // late it comes; nothing for a project that's gone.
        const sentAt = Date.parse(event.mail?.timestamp ?? "");
        const day = new Date(Number.isNaN(sentAt) ? now : sentAt).toISOString().slice(0, 10);
        const column = Prisma.raw(`"${count.column}"`);
        await tx.$executeRaw`
          INSERT INTO "project_email_day" ("projectId", "day", ${column})
          SELECT "id", ${day}::date, 1 FROM "project" WHERE "id" = ${count.projectId}
          ON CONFLICT ("projectId", "day") DO UPDATE SET ${column} = "project_email_day".${column} + 1`;
      }
      if (change && id && reply) {
        await apply(tx, id, change, event, now);
      }
    });
  } catch (error) {
    if (error instanceof NotSavedYet) {
      return false;
    }
    throw error;
  }
  if (added && count && count.column !== "sent") {
    await pauseIfOver(count.projectId);
  }
  return true;
}

/** Pauses the project's email if its rates went over, and tells the operator (with the link that resumes it) and its owners and admins. */
async function pauseIfOver(projectId: string) {
  const reason = await pauseIfOverLimits(projectId);
  if (!reason) {
    return;
  }
  log.warn("Paused a project's email", { projectId, reason });
  if (!emailConfigured()) {
    return;
  }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, slug: true, team: { where: { role: { in: ["OWNER", "ADMIN"] }, user: { emailVerified: true } }, select: { user: { select: { email: true } } } } },
  });
  const operator = process.env.APP_PORTAL_OWNER?.trim();
  const settingsUrl = new URL(`/app/${project.slug}/settings/support`, appUrl()).toString();
  const sent = await Promise.allSettled([
    ...(operator
      ? [
          sendEmail({
            to: operator,
            ...emailPausedEmail({
              projectName: project.name,
              reason,
              portalUrl: await portalAddress(project.slug),
              url: new URL(`/resume-email?token=${encodeURIComponent(resumeToken(projectId))}`, appUrl()).toString(),
            }),
          }),
        ]
      : []),
    // Their answers go to the operator.
    ...project.team.map(({ user }) => sendEmail({ to: user.email, replyTo: operator, ...emailPausedTeamEmail({ projectName: project.name, reason, url: settingsUrl }) })),
  ]);
  for (const result of sent) {
    if (result.status === "rejected") {
      log.error("Emailing that a project's email is paused failed", { projectId, error: result.reason });
    }
  }
}

async function apply(tx: Prisma.TransactionClient, id: string, change: { status: EmailStatus; after: EmailStatus[] }, event: SesEvent, now: number) {
  // One message per email carries its id: the email's last.
  const message = await tx.conversationMessage.findUnique({
    where: { deliveredMessageId: id },
    select: { id: true, projectId: true, conversationId: true, createdAt: true, conversation: { select: { userId: true, visitorHash: true } } },
  });
  if (!message) {
    // Rolled back, so SNS's next try counts.
    if (now - Date.parse(event.mail?.timestamp ?? "") < UNSAVED_FOR_MS) {
      throw new NotSavedYet();
    }
    return;
  }
  // The email had the team's messages since the previous email's last one.
  const previous = await tx.conversationMessage.findFirst({
    where: { conversationId: message.conversationId, sentMessageId: { not: null }, createdAt: { lt: message.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const diagnostic = event.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
  await tx.conversationMessage.updateMany({
    where: {
      conversationId: message.conversationId,
      author: "TEAM",
      note: false,
      createdAt: { lte: message.createdAt, ...(previous && { gt: previous.createdAt }) },
      emailStatus: { in: change.after },
    },
    data: {
      emailStatus: change.status,
      ...(change.status === "BOUNCED" && {
        emailError: `${event.bounce?.bounceType === "Permanent" ? "The address doesn't take email" : "Their mail server didn't take it"}${diagnostic ? ` (${diagnostic.slice(0, 300)})` : ""}`,
      }),
    },
  });
  const complained = (event.complaint?.complainedRecipients ?? []).flatMap((r) => (r.emailAddress ? [r.emailAddress.toLowerCase()] : []));
  if (complained.length > 0) {
    await tx.emailBlock.createMany({ data: complained.map((email) => ({ projectId: message.projectId, email })), skipDuplicates: true });
  }
  await notifyInbox(tx, { projectId: message.projectId, conversationId: message.conversationId, userId: message.conversation.userId, visitorHash: message.conversation.visitorHash });
}
