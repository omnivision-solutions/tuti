import { prisma } from "@tuti/db";
import { sendEmail, shippedEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import { portalOrigin, portalPostUrl } from "./events";
import { enqueue, type JobLogger, type JobResult } from "./index";

/** An unsent claim (or a due post) this old belongs to a run that died or never started. */
const LATE_MINUTES = 10;
/** After a day, a post's emails aren't news anymore. */
const RESUBMIT_FOR_HOURS = 24;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

/** Takes on emailing one person: a new claim, or one a crashed run left unsent. False when someone else has it or it's sent. */
async function claim(postId: string, userId: string): Promise<boolean> {
  const { count } = await prisma.shippedEmail.createMany({ data: [{ postId, userId }], skipDuplicates: true });
  if (count === 1) {
    return true;
  }
  const taken = await prisma.shippedEmail.updateMany({
    where: { postId, userId, sentAt: null, claimedAt: { lt: late() } },
    data: { claimedAt: new Date() },
  });
  return taken.count === 1;
}

/**
 * A post became Completed: emails its author, voters and commenters that it
 * shipped. Only to addresses someone vouched for (verified, or asserted by the
 * project's SSO), never to the team, and not to people who unsubscribed.
 */
export async function postShipped({ postId }: JobInput<"postShipped">, log: JobLogger): Promise<JobResult> {
  // Only while it's still shipped (the team may have reopened it since) and not merged away.
  const post = await prisma.post.findFirst({
    where: { id: postId, status: "COMPLETED", duplicateOfId: null },
    select: {
      number: true,
      title: true,
      projectId: true,
      authorId: true,
      project: { select: { name: true, slug: true } },
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
  const people = await prisma.user.findMany({
    where: { id: { in: ids }, teamMemberships: { none: { projectId } }, emailOptOuts: { none: { projectId } } },
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
    if (!(await claim(postId, person.id))) {
      continue;
    }
    const row = { postId_userId: { postId, userId: person.id } };
    const token = encodeURIComponent(person.unsubscribeToken);
    const unsubscribeUrl = `${origin}/unsubscribe?token=${token}`;
    try {
      await sendEmail({
        to: address,
        ...shippedEmail({ projectName: project.name, postTitle: post.title, postUrl, unsubscribeUrl }),
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: {
          "List-Unsubscribe": `<${origin}/unsubscribe/confirm?token=${token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await prisma.shippedEmail.update({ where: row, data: { sentAt: new Date() } });
      emailed++;
    } catch (error) {
      // Released, so the job's retry emails them.
      await prisma.shippedEmail.delete({ where: row });
      failed++;
      log.warn(`couldn't email that post ${postId} shipped: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} shipped email(s) for post ${postId} failed; retrying those`);
  }
  await prisma.post.update({ where: { id: postId }, data: { shippedEmailsDueAt: null } });
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
