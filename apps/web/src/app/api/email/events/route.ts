import { log } from "@tuti/shared";
import { ses } from "@tuti/shared/ses";

import { type SnsMessage, snsSignatureValid, snsUrl } from "@/lib/sns";
import { recordEmailEvent } from "@/server/email-events";

/** SNS's messages are 256 KB at most. */
const MAX_BYTES = 300_000;

/**
 * Amazon SES's events for the support inbox's emails, through SNS (docs/plan.md, Support inbox,
 * item 11): signed by SNS, and only from SES_EVENTS_TOPIC_ARN (a valid signature only proves SNS
 * sent it, and anyone can point their own topic here). The subscription is confirmed for that topic
 * only. Off (404) without SES. A 500 has SNS try again.
 */
export async function POST(request: Request) {
  if (!ses()) {
    return Response.json({ error: "This server doesn't use Amazon SES" }, { status: 404 });
  }
  const text = await request.text();
  if (text.length > MAX_BYTES) {
    return Response.json({ error: "Too large" }, { status: 413 });
  }
  let message: SnsMessage;
  try {
    message = JSON.parse(text) as SnsMessage;
  } catch {
    return Response.json({ error: "Not an SNS message" }, { status: 400 });
  }
  if (message?.TopicArn !== process.env.SES_EVENTS_TOPIC_ARN) {
    return Response.json({ error: "Not this server's topic" }, { status: 403 });
  }
  if (!(await snsSignatureValid(message))) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  if (message.Type === "SubscriptionConfirmation") {
    if (!snsUrl(message.SubscribeURL)) {
      return Response.json({ error: "Not an SNS address" }, { status: 400 });
    }
    const confirmed = await fetch(message.SubscribeURL!, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    log.info("Confirming the SES events subscription", { status: confirmed?.status });
    return Response.json({}, { status: confirmed?.ok ? 200 : 502 });
  }
  if (message.Type === "Notification") {
    let event: Parameters<typeof recordEmailEvent>[1];
    try {
      event = JSON.parse(message.Message) as typeof event;
    } catch {
      return Response.json({ error: "Not an SES event" }, { status: 400 });
    }
    await recordEmailEvent(message.MessageId, event);
  }
  return Response.json({});
}
