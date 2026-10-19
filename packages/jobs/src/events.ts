import { randomUUID } from "node:crypto";

import { type PostStatus, type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { postPath } from "@tuti/shared/post-urls";

import { enqueue } from "./index";

/**
 * Tells a project's webhooks that something happened: one delivery per webhook
 * that wants this event, all with the same event id, sent by the webhook-delivery
 * job. Never fails the request that caused it. `only` sends to one webhook (tests).
 */
export async function emitEvent(
  projectId: string,
  type: string,
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
        // With inline jobs a failed attempt lands here (recorded on the delivery). If queueing
        // failed, the webhook-resubmit job queues the delivery again.
        log.warn("Webhook delivery failed or couldn't be queued", { deliveryId: delivery.id, error });
      }
    }
  } catch (error) {
    log.error("Emitting a webhook event failed", { projectId, type, error });
  }
}

/**
 * Every status change goes through here: it tells the project's webhooks and,
 * when the post is now Completed, emails the people behind it (post-shipped job).
 */
export async function postStatusChanged(
  projectId: string,
  postId: string,
  post: ReturnType<typeof postSummary>,
  previousStatus: PostStatus,
) {
  await emitEvent(projectId, "post.status_changed", { post, previousStatus: toApiStatus(previousStatus) });
  if (post.status === toApiStatus("COMPLETED")) {
    try {
      // Saved first: if queueing fails, the shipped-emails-resubmit cron finds it.
      await prisma.post.update({ where: { id: postId }, data: { shippedEmailsDueAt: new Date() } });
      await enqueue("postShipped", { postId });
    } catch (error) {
      log.error("Enqueueing the post-shipped job failed", { postId, error });
    }
  }
}

/** A post as the API and webhook payloads show it. */
export type PostRow = {
  number: number;
  title: string;
  status: PostStatus;
  voteCount: number;
  commentCount: number;
  createdAt: Date;
  board: { slug: string };
  author: { name: string };
};

export const postSummarySelect = {
  number: true,
  title: true,
  status: true,
  voteCount: true,
  commentCount: true,
  createdAt: true,
  board: { select: { slug: true } },
  author: { select: { name: true } },
} as const;

/** Statuses as the API spells them. */
export const toApiStatus = (status: PostStatus) => status.toLowerCase();

/** The post's public URL on its project's portal (PORTAL_URL_TEMPLATE, e.g. https://{project}.tuti.so). */
export function portalPostUrl(projectSlug: string, post: { title: string; number: number }) {
  return `${portalOrigin(projectSlug)}${postPath(post)}`;
}

/** A project's portal origin from PORTAL_URL_TEMPLATE (required, like in the web app). */
export function portalOrigin(projectSlug: string): string {
  const template = process.env.PORTAL_URL_TEMPLATE;
  if (!template?.includes("{project}")) {
    throw new Error("PORTAL_URL_TEMPLATE must be set and contain {project}");
  }
  return new URL(template.replace("{project}", projectSlug)).origin;
}

export const postSummary = (post: PostRow, projectSlug: string) => ({
  number: post.number,
  title: post.title,
  status: toApiStatus(post.status),
  board: post.board.slug,
  votes: post.voteCount,
  comments: post.commentCount,
  author: { name: post.author.name },
  createdAt: post.createdAt.toISOString(),
  url: portalPostUrl(projectSlug, post),
});
