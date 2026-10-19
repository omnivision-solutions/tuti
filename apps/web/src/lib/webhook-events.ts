/** Events webhooks can get, with how settings describe them. */
export const WEBHOOK_EVENTS = {
  "post.created": "New post",
  "post.status_changed": "Status changed",
  "comment.created": "New comment",
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
