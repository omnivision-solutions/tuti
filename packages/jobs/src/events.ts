import { randomUUID } from "node:crypto";

import { type PostStatus, type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { postPath } from "@tuti/shared/post-urls";

import { enqueue } from "./index";
import type { PortalAddress } from "./portal-address";

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
    await queueDeliveries(await recordEvent(prisma, projectId, type, data, { only }));
  } catch (error) {
    log.error("Emitting a webhook event failed", { projectId, type, error });
  }
}

/**
 * The deliveries of an event, saved (with `db`, which can be a transaction, so they
 * commit with the change they describe) but not sent: pass their ids to
 * `queueDeliveries` after it commits. Throws if they can't be saved.
 */
export async function recordEvent(
  db: Prisma.TransactionClient,
  projectId: string,
  type: string,
  data: Record<string, unknown>,
  { only }: { only?: string } = {},
): Promise<string[]> {
  const hooks = await db.webhook.findMany({
    where: { projectId, ...(only ? { id: only } : { events: { has: type } }) },
    select: { id: true },
  });
  if (hooks.length === 0) {
    return [];
  }
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, name: true } });
  const eventId = `evt_${randomUUID()}`;
  // JSON round trip: dates become strings, as receivers will see them.
  const payload = JSON.parse(
    JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), project, data }),
  ) as Prisma.InputJsonValue;
  const deliveries = await db.webhookDelivery.createManyAndReturn({
    data: hooks.map((hook) => ({ webhookId: hook.id, eventId, event: type, payload })),
    select: { id: true },
  });
  return deliveries.map((d) => d.id);
}

/** Sends saved deliveries. One that can't be queued now is queued again by the webhook-resubmit job. */
export async function queueDeliveries(ids: string[]) {
  for (const deliveryId of ids) {
    try {
      await enqueue("webhookDelivery", { deliveryId });
    } catch (error) {
      // With inline jobs a failed attempt lands here (recorded on the delivery).
      log.warn("Webhook delivery failed or couldn't be queued", { deliveryId, error });
    }
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

/** The post's public URL on its project's portal (`portal`: the portal's address, see portalAddress). */
export function portalPostUrl(portal: PortalAddress, post: { title: string; number: number; board: { slug: string } }) {
  return `${portal}${postPath(post)}`;
}

/** A project's portal origin from PORTAL_URL_TEMPLATE (required, like in the web app). */
export function portalOrigin(projectSlug: string): string {
  const template = process.env.PORTAL_URL_TEMPLATE;
  if (!template?.includes("{project}")) {
    throw new Error("PORTAL_URL_TEMPLATE must be set and contain {project}");
  }
  return new URL(template.replace("{project}", projectSlug)).origin;
}

/** A post for the API and webhooks; `portal` is its portal's address (portalAddress). */
export const postSummary = (post: PostRow, portal: PortalAddress) => ({
  number: post.number,
  title: post.title,
  status: toApiStatus(post.status),
  board: post.board.slug,
  votes: post.voteCount,
  comments: post.commentCount,
  author: { name: post.author.name },
  createdAt: post.createdAt.toISOString(),
  url: portalPostUrl(portal, post),
});
