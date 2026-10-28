import { type EmailStatus, prisma } from "@tuti/db";
import { deliveredMessageId } from "@tuti/email";

import { notifyInbox } from "./live";

/**
 * What became of the support inbox's emails, from Amazon SES's events (docs/plan.md, Support inbox,
 * item 11; they come through SNS to /api/email/events). The email is found by the id SES gave it
 * when it was sent (kept as its Message-ID), and its status only moves forward: sent → delivered →
 * bounced or complained, so a late delivery never hides a bounce. A complaint also stops replies by
 * email to that address for the project. Each SNS message counts once.
 */
type SesEvent = {
  eventType?: string;
  mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
};

/** Each status, and the ones it may follow. */
const FORWARD: Partial<Record<string, { status: EmailStatus; after: EmailStatus[] }>> = {
  Delivery: { status: "DELIVERED", after: ["SENT"] },
  Bounce: { status: "BOUNCED", after: ["SENT", "DELIVERED"] },
  Complaint: { status: "COMPLAINED", after: ["SENT", "DELIVERED", "BOUNCED"] },
};

export async function recordEmailEvent(snsMessageId: string, event: SesEvent) {
  const change = FORWARD[event.eventType ?? ""];
  const id = deliveredMessageId(`250 Ok ${event.mail?.messageId ?? ""}`);
  if (!change || !id) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.emailEvent.createMany({ data: [{ id: snsMessageId }], skipDuplicates: true });
    if (count === 0) {
      return;
    }
    // One message per email carries its id: the email's last.
    const message = await tx.conversationMessage.findUnique({
      where: { deliveredMessageId: id },
      select: { id: true, projectId: true, conversation: { select: { id: true, userId: true, visitorHash: true } } },
    });
    if (!message) {
      return;
    }
    const diagnostic = event.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
    await tx.conversationMessage.updateMany({
      where: { id: message.id, emailStatus: { in: change.after } },
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
    await notifyInbox(tx, { projectId: message.projectId, conversationId: message.conversation.id, userId: message.conversation.userId, visitorHash: message.conversation.visitorHash });
  });
}
