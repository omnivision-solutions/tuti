import { prisma } from "@tuti/db";
import { sendEmail, shippedEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import { portalPostUrl } from "./events";
import { postAudience } from "./post-audience";
import { portalAddress } from "./portal-address";
import { claimProjectEmail } from "./email-limits";
import { projectEmailWaits, projectSender } from "./project-sender";
import { enqueue, type JobLogger, type JobResult } from "./index";

/** An unsent claim (or a due post) this old belongs to a run that died or never started. */
const LATE_MINUTES = 10;
/** After a day, a post's emails aren't news anymore. */
const RESUBMIT_FOR_HOURS = 24;

/** Well under LATE_MINUTES, so a live run's claim never looks abandoned. */
const RENEW_MS = 60_000;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

/**
 * Takes on emailing one person: a new claim, or one a crashed run left unsent.
 * Returns the claim's time, which the run then uses to mark it sent or release
 * it (so it never touches a claim another run took over); null when someone else
 * has it or it's sent.
 */
async function claim(postId: string, userId: string): Promise<Date | null> {
  return prisma.$transaction(async (tx) => {
    // Only while it's still shipped: the post's row locked, so a status change (Undo, say) waits for
    // this claim, or this claim sees it and emails nobody else. One claimed already may still go.
    const [post] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM post WHERE id = ${postId} FOR UPDATE`;
    if (post?.status !== "COMPLETED") {
      return null;
    }
    // For this completion (its activity counts who it reached), read under the same lock.
    const completion = await tx.postEvent.findFirst({ where: { postId, to: "COMPLETED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const eventId = completion?.id ?? null;
    const claimedAt = new Date();
    const { count } = await tx.shippedEmail.createMany({ data: [{ postId, userId, claimedAt, eventId }], skipDuplicates: true });
    if (count === 1) {
      return claimedAt;
    }
    const taken = await tx.shippedEmail.updateMany({
      where: { postId, userId, sentAt: null, claimedAt: { lt: late() } },
      data: { claimedAt, eventId },
    });
    return taken.count === 1 ? claimedAt : null;
  });
}

/**
 * Sends while holding a claim: renews it every minute meanwhile, so it's only
 * taken over once this run is gone, however long the send takes. Then marks it
 * sent, or (if the send failed) releases it for a retry. Both touch only this
 * run's claim: one taken over is someone else's. Returns the send's error, if any.
 */
async function whileClaimed(claim: { postId: string; userId: string; claimedAt: Date }, send: () => Promise<unknown>) {
  const { postId, userId } = claim;
  let current = claim.claimedAt;
  let renewing = Promise.resolve();
  const renew = async () => {
    const next = new Date();
    const { count } = await prisma.shippedEmail.updateMany({ where: { postId, userId, claimedAt: current }, data: { claimedAt: next } });
    if (count === 1) {
      current = next;
    }
  };
  const heartbeat = setInterval(() => (renewing = renewing.then(renew, renew)), RENEW_MS);
  let error: Error | null = null;
  try {
    await send();
  } catch (e) {
    error = e as Error;
  } finally {
    clearInterval(heartbeat);
    await renewing.catch(() => {});
  }
  const mine = { postId, userId, claimedAt: current };
  if (error) {
    await prisma.shippedEmail.deleteMany({ where: mine });
    return error;
  }
  // Sent: never released from here on. If saving this fails, the claim stays unsent and is
  // taken over later, which may email them twice; better than not at all.
  // Counted on its completion in the same write: only by the run that marks it sent, once.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.shippedEmail.updateMany({ where: mine, data: { sentAt: new Date() } });
    const sent = count === 1 ? await tx.shippedEmail.findUnique({ where: { postId_userId: { postId, userId } }, select: { eventId: true } }) : null;
    if (sent?.eventId) {
      await tx.postEvent.update({ where: { id: sent.eventId }, data: { emailed: { increment: 1 } } });
    }
  });
  return null;
}

/**
 * A post became Completed: emails its author, voters, commenters and subscribers that it
 * shipped (as postAudience has who may be told), each once.
 */
export async function postShipped({ postId }: JobInput<"postShipped">, log: JobLogger): Promise<JobResult> {
  // Only while it's still shipped (the team may have reopened it since) and not merged away; never for sample content
  // (Home's "Add sample content"), whatever completed it.
  const post = await prisma.post.findFirst({
    where: { id: postId, status: "COMPLETED", duplicateOfId: null, sample: false },
    select: {
      number: true,
      title: true,
      board: { select: { slug: true } },
      projectId: true,
      authorId: true,
      project: { select: { name: true, slug: true, portalAccess: true, plan: true } },
      votes: { select: { userId: true } },
      comments: { select: { authorId: true } },
      subscriptions: { select: { userId: true } },
    },
  });
  if (!post) {
    await prisma.post.updateMany({ where: { id: postId }, data: { shippedEmailsDueAt: null } });
    return { skipped: true };
  }
  const { projectId, project } = post;
  // The project's email is paused: still due, so the cron brings it back (for a day) once it's resumed.
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const people = await postAudience(projectId, project, [
    post.authorId,
    ...post.votes.map((v) => v.userId),
    ...post.comments.map((c) => c.authorId),
    ...post.subscriptions.map((s) => s.userId),
  ]);
  if (people.length === 0) {
    // Claims a crashed try left unsent won't be sent now (a private portal that's the team's only, say): dropped,
    // so the post isn't due again and again. A run still sending keeps its claim (not stale yet), so it can mark it sent.
    await prisma.shippedEmail.deleteMany({ where: { postId, sentAt: null, claimedAt: { lt: late() } } });
  }

  const origin = await portalAddress(project.slug);
  const sender = await projectSender(projectId);
  const postUrl = portalPostUrl(origin, post);
  let emailed = 0;
  let failed = 0;
  let held = false;
  for (const { id, address, unsubscribeToken } of people) {
    // Claimed before sending, so a retry, a second run or the post completed again doesn't email them twice.
    const claimedAt = await claim(postId, id);
    if (!claimedAt) {
      continue;
    }
    // A new project's daily cap, taken once they're ours to email (and a pause since the run began):
    // past it, they're let go and wait.
    if (!(await claimProjectEmail(projectId))) {
      await prisma.shippedEmail.deleteMany({ where: { postId, userId: id, claimedAt } });
      held = true;
      break;
    }
    const token = encodeURIComponent(unsubscribeToken);
    const unsubscribeUrl = `${origin}/unsubscribe?token=${token}`;
    const error = await whileClaimed({ postId, userId: id, claimedAt }, () =>
      sendEmail({
        to: address,
        ...shippedEmail({ projectName: project.name, postTitle: post.title, postUrl, unsubscribeUrl }),
        ...sender,
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: {
          ...sender.headers,
          "List-Unsubscribe": `<${origin}/unsubscribe/confirm?token=${token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
    if (error) {
      failed++;
      log.warn(`couldn't email that post ${postId} shipped: ${error.message}`);
      continue;
    }
    emailed++;
  }
  if (failed > 0) {
    throw new Error(`${failed} shipped email(s) for post ${postId} failed; retrying those`);
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back a day) until the rest may go.
    await prisma.post.updateMany({ where: { id: postId, shippedEmailsDueAt: { not: null } }, data: { shippedEmailsDueAt: new Date() } });
    log.info(`post ${postId} shipped: emailed ${emailed}, the rest wait (the project's daily cap, or a pause)`);
    return { emailed, waiting: "the project's daily cap, or a pause" };
  }
  // Done once nobody's email is left in flight: if another run is still sending one and dies, the cron needs to find this post.
  await prisma.post.updateMany({
    where: { id: postId, shippedEmails: { none: { sentAt: null } } },
    data: { shippedEmailsDueAt: null },
  });
  log.info(`post ${postId} shipped: emailed ${emailed}`);
  return { emailed };
}

/**
 * The safety net: a post whose emails are still due after a while (its job was
 * never queued, or died mid-send) gets its job again. Claims keep that from emailing anyone twice.
 */
export async function resubmitShippedEmails(_input: JobInput<"resubmitShippedEmails">, log: JobLogger): Promise<JobResult> {
  const due = await prisma.post.findMany({
    where: { shippedEmailsDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } },
    select: { id: true },
    take: 500,
  });
  let queued = 0;
  for (const post of due) {
    try {
      await enqueue("postShipped", { postId: post.id });
      queued++;
    } catch (error) {
      log.warn(`couldn't queue shipped emails for post ${post.id} again: ${(error as Error).message}`);
    }
  }
  if (due.length > 0) {
    log.info(`queued shipped emails again for ${queued} of ${due.length} posts`);
  }
  return { found: due.length, queued };
}
