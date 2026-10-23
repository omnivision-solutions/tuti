import { timeAgo } from "./format";

/** Events webhooks can get, with how settings describe them. */
export const WEBHOOK_EVENTS = {
  "post.created": "New post",
  "post.status_changed": "Status changed",
  "comment.created": "New comment",
  "changelog.published": "Changelog published",
  "code_change.ready": "Code change ready",
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

export type DeliverySummary = { createdAt: Date; deliveredAt: Date | null; lastError: string | null; attempts: number };

/** How settings describe a webhook's latest delivery. */
export function lastDeliveryText(delivery: DeliverySummary | null, now = new Date()): string {
  if (!delivery) {
    return "no deliveries yet";
  }
  if (!delivery.deliveredAt && delivery.attempts === 0) {
    return `delivery queued ${timeAgo(delivery.createdAt, now)}`;
  }
  return delivery.deliveredAt
    ? `last delivered ${timeAgo(delivery.deliveredAt, now)}`
    : `last delivery failed ${timeAgo(delivery.createdAt, now)}: ${delivery.lastError ?? "no answer"}`;
}
