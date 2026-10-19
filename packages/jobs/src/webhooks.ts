import { createHmac } from "node:crypto";

import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";
import { checkWebhookUrl, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import { enqueue, type JobLogger, type JobResult } from "./index";

const TIMEOUT_MS = 10_000;

/** Connects only to public addresses, checked when connecting (see publicOnlyLookup). */
const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/**
 * `Tuti-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * Receivers recompute it with their secret and reject old timestamps (replays).
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Sends one delivery. Anything but a 2xx answer throws, so the job is retried
 * with backoff; every attempt sends the same event id (at-least-once delivery).
 */
export async function webhookDelivery(input: JobInput<"webhookDelivery">, log: JobLogger): Promise<JobResult> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: input.deliveryId },
    include: { webhook: { select: { url: true, secret: true } } },
  });
  if (!delivery || delivery.deliveredAt) {
    return { skipped: true };
  }
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  let status: number | null = null;
  let error: string | null = null;
  try {
    await checkWebhookUrl(delivery.webhook.url);
    const response = await fetch(delivery.webhook.url, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(process.env.WEBHOOK_ALLOW_PRIVATE_URLS !== "true" && { dispatcher: publicOnly }),
      headers: {
        "content-type": "application/json",
        "user-agent": "Tuti-Webhooks/1",
        "tuti-event-id": delivery.eventId,
        "tuti-event-type": delivery.event,
        "tuti-signature": signWebhook(delivery.webhook.secret, body, timestamp),
      },
    });
    status = response.status;
    // The answer's body isn't used; closing it frees the connection right away.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      error = `Answered ${response.status}`;
    }
  } catch (e) {
    // fetch reports connection errors (like a private address) as its cause.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    error = cause instanceof Error ? cause.message : String(cause);
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { attempts: { increment: 1 }, lastStatus: status, lastError: error, ...(!error && { deliveredAt: new Date() }) },
  });
  if (error) {
    log.warn(`webhook delivery ${delivery.id} (${delivery.event}) failed: ${error}`);
    throw new Error(`Webhook delivery failed: ${error}`);
  }
  return { delivered: true, status: status ?? 0 };
}

/** A delivery not tried after this long probably never reached the queue. */
const UNSENT_AFTER_MINUTES = 5;
/** Older ones are past the retry window anyway. */
const RESUBMIT_FOR_HOURS = 24;

/**
 * The safety net for at-least-once delivery: deliveries are saved before their
 * job is queued, so if queueing failed (or the job got lost) the row is still
 * here, never attempted. Queues those again. A job that was merely slow may then
 * send twice, which receivers handle by skipping repeated event ids.
 */
export async function resubmitWebhookDeliveries(
  _input: JobInput<"resubmitWebhookDeliveries">,
  log: JobLogger,
): Promise<JobResult> {
  const now = Date.now();
  const unsent = await prisma.webhookDelivery.findMany({
    where: {
      attempts: 0,
      deliveredAt: null,
      createdAt: { lt: new Date(now - UNSENT_AFTER_MINUTES * 60_000), gt: new Date(now - RESUBMIT_FOR_HOURS * 3_600_000) },
    },
    select: { id: true },
    take: 500,
  });
  let queued = 0;
  for (const delivery of unsent) {
    try {
      await enqueue("webhookDelivery", { deliveryId: delivery.id });
      queued++;
    } catch (error) {
      log.warn(`couldn't queue delivery ${delivery.id} again: ${(error as Error).message}`);
    }
  }
  if (unsent.length > 0) {
    log.info(`queued ${queued} of ${unsent.length} unsent webhook deliveries again`);
  }
  return { found: unsent.length, queued };
}
