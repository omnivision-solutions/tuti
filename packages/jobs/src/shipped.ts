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
  // Claimed first, so it's once per post: a post completed again (or a redelivered job) doesn't email twice.
  // ponytail: a crash mid-send skips the rest; per-recipient rows if that ever matters.
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: "COMPLETED", duplicateOfId: null, shippedEmailedAt: null },
    data: { shippedEmailedAt: new Date() },
  });
  if (count === 0) {
    return { skipped: true };
  }
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
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
  const { projectId, project } = post;
  const ids = [...new Set([post.authorId, ...post.votes.map((v) => v.userId), ...post.comments.map((c) => c.authorId)])];
  const people = await prisma.user.findMany({
    where: { id: { in: ids }, teamMemberships: { none: { projectId } }, emailOptOuts: { none: { projectId } } },
    select: { email: true, emailVerified: true, unsubscribeToken: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });

  const origin = portalOrigin(project.slug);
  const postUrl = portalPostUrl(project.slug, post);
  const sentTo = new Set<string>();
  let failed = 0;
  for (const person of people) {
    const address =
      person.ssoIdentity?.projectId === projectId ? person.ssoIdentity.email : person.emailVerified ? person.email : null;
    if (!address || address.endsWith(".invalid") || sentTo.has(address.toLowerCase())) {
      continue;
    }
    sentTo.add(address.toLowerCase());
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
    } catch (error) {
      failed++;
      log.warn(`couldn't email that post ${postId} shipped: ${(error as Error).message}`);
    }
  }
  log.info(`post ${postId} shipped: emailed ${sentTo.size - failed}, ${failed} failed`);
  return { emailed: sentTo.size - failed, failed };
}
