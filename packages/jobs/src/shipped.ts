import { prisma } from "@tuti/db";
import { sendEmail, shippedEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import { portalOrigin, portalPostUrl } from "./events";
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
  const claimedAt = new Date();
  const { count } = await prisma.shippedEmail.createMany({ data: [{ postId, userId, claimedAt }], skipDuplicates: true });
  if (count === 1) {
    return claimedAt;
  }
  const taken = await prisma.shippedEmail.updateMany({
    where: { postId, userId, sentAt: null, claimedAt: { lt: late() } },
    data: { claimedAt },
  });
  return taken.count === 1 ? claimedAt : null;
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
  await prisma.shippedEmail.updateMany({ where: mine, data: { sentAt: new Date() } });
  return null;
}

/**
 * A post became Completed: emails its author, voters and commenters that it
 * shipped. Only to addresses someone vouched for (verified, or asserted by the
 * project's SSO), never to the team, and not to people who unsubscribed. On a private
 * portal, only to people who may still read it (its SSO users and readers).
 */
export async function postShipped({ postId }: JobInput<"postShipped">, log: JobLogger): Promise<JobResult> {
  // Only while it's still shipped (the team may have reopened it since) and not merged away.
  const post = await prisma.post.findFirst({
    where: { id: postId, status: "COMPLETED", duplicateOfId: null },
    select: {
      number: true,
      title: true,
      board: { select: { slug: true } },
      projectId: true,
      authorId: true,
      project: { select: { name: true, slug: true, portalAccess: true } },
      votes: { select: { userId: true } },
      comments: { select: { authorId: true } },
    },
  });
  if (!post) {
    await prisma.post.updateMany({ where: { id: postId }, data: { shippedEmailsDueAt: null } });
    return { skipped: true };
  }
  const { projectId, project } = post;
  const ids = [...new Set([post.authorId, ...post.votes.map((v) => v.userId), ...post.comments.map((c) => c.authorId)])];
  // A private portal's post is only for its readers: past the team, the people its SSO signs in and
  // the readers the team added by email (verified, as server/portal-access.ts asks).
  const readers =
    project.portalAccess === "PRIVATE"
      ? (await prisma.portalReader.findMany({ where: { projectId }, select: { email: true } })).map((r) => r.email)
      : [];
  const people = await prisma.user.findMany({
    where: {
      id: { in: ids },
      teamMemberships: { none: { projectId } },
      emailOptOuts: { none: { projectId } },
      ...(project.portalAccess === "PRIVATE" && {
        OR: [
          { ssoIdentity: { projectId } },
          { emailVerified: true, email: { in: readers.filter((r) => !r.startsWith("@")), mode: "insensitive" } },
          // A domain ("@acme.com"): everyone with a verified address there.
          ...readers.filter((r) => r.startsWith("@")).map((domain) => ({ emailVerified: true, email: { endsWith: domain, mode: "insensitive" as const } })),
        ],
      }),
    },
    select: { id: true, email: true, emailVerified: true, unsubscribeToken: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });

  const origin = portalOrigin(project.slug);
  const postUrl = portalPostUrl(project.slug, post);
  const sentTo = new Set<string>();
  let emailed = 0;
  let failed = 0;
  for (const person of people) {
    const address =
      person.ssoIdentity?.projectId === projectId ? person.ssoIdentity.email : person.emailVerified ? person.email : null;
    if (!address || address.endsWith(".invalid") || sentTo.has(address.toLowerCase())) {
      continue;
    }
    sentTo.add(address.toLowerCase());
    // Claimed before sending, so a retry, a second run or the post completed again doesn't email them twice.
    const claimedAt = await claim(postId, person.id);
    if (!claimedAt) {
      continue;
    }
    const token = encodeURIComponent(person.unsubscribeToken);
    const unsubscribeUrl = `${origin}/unsubscribe?token=${token}`;
    const error = await whileClaimed({ postId, userId: person.id, claimedAt }, () =>
      sendEmail({
        to: address,
        ...shippedEmail({ projectName: project.name, postTitle: post.title, postUrl, unsubscribeUrl }),
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: {
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
