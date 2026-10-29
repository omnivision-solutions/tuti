import { type EmailStatus, Prisma, prisma } from "@tuti/db";
import { deliveredMessageId } from "@tuti/email";
import { pauseIfOverLimits, tellPaused } from "@tuti/jobs";
import { log, plansEnabled } from "@tuti/shared";

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
  try {
    await prisma.$transaction(async (tx) => {
      const { count: added } = await tx.emailEvent.createMany({ data: [{ id: snsMessageId }], skipDuplicates: true });
      if (added === 0) {
        return;
      }
      if (count) {
        // On the day (UTC) the email was sent, so a bounce counts against that day's sends however
        // late it comes; nothing for a project that's gone, nor for an email sent before its email was
        // last resumed (packages/jobs/src/email-limits.ts).
        const parsed = Date.parse(event.mail?.timestamp ?? "");
        const sentAt = new Date(Number.isNaN(parsed) ? now : parsed);
        const column = Prisma.raw(`"${count.column}"`);
        await tx.$executeRaw`
          INSERT INTO "project_email_day" ("projectId", "day", ${column})
          SELECT "id", ${sentAt.toISOString().slice(0, 10)}::date, 1 FROM "project"
          WHERE "id" = ${count.projectId} AND ("emailResumedAt" IS NULL OR "emailResumedAt" <= ${sentAt})
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
  // After every counted event, a repeat too: a check that failed, or telling the operator, is tried
  // again with SNS's next try. Sends as well: late ones can take a project past the minimum.
  if (count) {
    await pauseIfOver(count.projectId);
  }
  return true;
}

/** Pauses the project's email if its rates went over, then tells whoever wasn't told yet. */
async function pauseIfOver(projectId: string) {
  const reason = await pauseIfOverLimits(projectId);
  if (reason) {
    log.warn("Paused a project's email", { projectId, reason });
  }
  await tellPaused(projectId);
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
