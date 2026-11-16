import { randomUUID } from "node:crypto";

import { type PostStatus, type PostVisibility, type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { statusMoveEmails } from "@tuti/shared/status-emails";
import { postPath } from "@tuti/shared/post-urls";

import { enqueue } from "./index";
import type { PortalAddress } from "./portal-address";
import { seenAs } from "./post-audience";

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
 * when the post is now Planned, In progress or Completed, emails the people behind it (post-shipped job).
 */
export async function postStatusChanged(
  projectId: string,
  postId: string,
  post: ReturnType<typeof postSummary>,
  previousStatus: PostStatus,
  /**
   * `email` false: a move nobody on the team approved (Autopilot's progress update going out by itself), which emails
   * nobody. `generation`: the post's moves counted with this one (postGeneration), so a later move (even back to this
   * status) is left to its own handler.
   */
  { email = true, generation = null }: { email?: boolean; generation?: number | null } = {},
) {
  // Sample content (Home's "Add sample content") reaches no webhooks, and its voters aren't emailed.
  if ((await prisma.post.count({ where: { id: postId, sample: true } })) > 0) {
    return;
  }
  await emitEvent(projectId, "post.status_changed", { post, previousStatus: toApiStatus(previousStatus) });
  // Which email the move sends (statusMoveEmails: Completed however it's reached; Planned and In progress only moving
  // forward, so an Undo or a reopened post moving back tells nobody). A move that emails nobody leaves nothing due (an
  // earlier move's held emails would go out about this status).
  const emailed = email && statusMoveEmails(previousStatus, post.status.toUpperCase() as PostStatus) !== null;
  // Only while the post still has this change's status: another change made while the webhooks were told is the
  // post's own to settle, and this one mustn't clear (or set) its emails' due time.
  // Nor once the post moved again since this move (`generation`), even back to this status: that move's due time is its own.
  const still = { id: postId, status: post.status.toUpperCase() as PostStatus };
  // Not for a post only the team sees (Team only, or on a board turned off): nobody is to be told, and turning its board
  // on later mustn't find its emails still due, an earlier completion's either.
  if (!emailed || post.visibility === "team") {
    await whileUnmoved(postId, generation, (db) => db.post.updateMany({ where: { ...still, shippedEmailsDueAt: { not: null } }, data: { shippedEmailsDueAt: null } }));
  } else {
    try {
      // Saved first: if queueing fails, the shipped-emails-resubmit cron finds it.
      const set = await whileUnmoved(postId, generation, (db) => db.post.updateMany({ where: still, data: { shippedEmailsDueAt: new Date() } }));
      if (set && set.count > 0) {
        await enqueue("postShipped", { postId });
      }
    } catch (error) {
      log.error("Enqueueing the post-shipped job failed", { postId, error });
    }
  }
}

/**
 * A post's generation: how many moves it has had (its post_event rows). Every move adds one under the post's row lock
 * (posts.update, publishing a changelog entry), so it only grows, one per committed move, whatever their timestamps.
 */
export async function postGeneration(postId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  return db.postEvent.count({ where: { postId } });
}

/**
 * Runs `write` (a write only a move's own handler or run may make) only while the post is still at `generation`
 * (postGeneration): checked and written under the post's row lock, so no move lands in between. Null: no check. Returns
 * what `write` returned, or null when the post moved since.
 */
export async function whileUnmoved<T>(postId: string, generation: number | null, write: (db: Prisma.TransactionClient) => Promise<T>): Promise<T | null> {
  if (generation === null) {
    return write(prisma);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM post WHERE id = ${postId} FOR UPDATE`;
    return (await postGeneration(postId, tx)) === generation ? write(tx) : null;
  });
}

/** A post as the API and webhook payloads show it. */
export type PostRow = {
  number: number;
  title: string;
  status: PostStatus;
  voteCount: number;
  commentCount: number;
  createdAt: Date;
  visibility: PostVisibility;
  board: { slug: string; off: boolean };
  author: { name: string };
};

export const postSummarySelect = {
  number: true,
  title: true,
  status: true,
  voteCount: true,
  commentCount: true,
  createdAt: true,
  visibility: true,
  board: { select: { slug: true, off: true } },
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
  /** Who sees it besides the team: everyone (public), its author (private), nobody (team, or on a board turned off: seenAs). */
  visibility: seenAs(post).toLowerCase() as "public" | "private" | "team",
  createdAt: post.createdAt.toISOString(),
  url: portalPostUrl(portal, post),
});
