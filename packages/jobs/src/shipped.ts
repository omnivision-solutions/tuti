import { prisma } from "@tuti/db";
import { sendEmail, shippedEmail } from "@tuti/email";
import type { JobInput } from "@tuti/shared";

import { portalOrigin, portalPostUrl } from "./events";
import type { JobLogger, JobResult } from "./index";

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
    // One row per person, claimed before sending: a retry, a second job or the post completed again skips them.
    const { count } = await prisma.shippedEmail.createMany({ data: [{ postId, userId: person.id }], skipDuplicates: true });
    if (count === 0) {
      continue;
    }
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
      emailed++;
    } catch (error) {
      // Released, so the job's retry emails them.
      await prisma.shippedEmail.delete({ where: { postId_userId: { postId, userId: person.id } } });
      failed++;
      log.warn(`couldn't email that post ${postId} shipped: ${(error as Error).message}`);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} shipped email(s) for post ${postId} failed; retrying those`);
  }
  log.info(`post ${postId} shipped: emailed ${emailed}`);
  return { emailed };
}
