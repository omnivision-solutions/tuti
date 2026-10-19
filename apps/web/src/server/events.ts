import { randomUUID } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";

import type { WebhookEvent } from "@/lib/webhook-events";

/**
 * Tells a project's webhooks that something happened: one delivery per webhook
 * that wants this event, all with the same event id, sent by the webhook-delivery
 * job. Never fails the request that caused it. `only` sends to one webhook (tests).
 */
export async function emitEvent(
  projectId: string,
  type: WebhookEvent | "ping",
  data: Record<string, unknown>,
  { only }: { only?: string } = {},
) {
  try {
    const hooks = await prisma.webhook.findMany({
      where: { projectId, ...(only ? { id: only } : { events: { has: type } }) },
      select: { id: true },
    });
    if (hooks.length === 0) {
      return;
    }
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true } });
    const eventId = `evt_${randomUUID()}`;
    // JSON round trip: dates become strings, as receivers will see them.
    const payload = JSON.parse(
      JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), project, data }),
    ) as Prisma.InputJsonValue;
    const deliveries = await prisma.webhookDelivery.createManyAndReturn({
      data: hooks.map((hook) => ({ webhookId: hook.id, eventId, event: type, payload })),
      select: { id: true },
    });
    for (const delivery of deliveries) {
      try {
        await enqueue("webhookDelivery", { deliveryId: delivery.id });
      } catch (error) {
        // With inline jobs a failed attempt lands here; it's recorded on the delivery.
        log.warn("Webhook delivery failed or couldn't be queued", { deliveryId: delivery.id, error });
      }
    }
  } catch (error) {
    log.error("Emitting a webhook event failed", { projectId, type, error });
  }
}
