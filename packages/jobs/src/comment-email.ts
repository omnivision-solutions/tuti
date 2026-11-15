import { prisma } from "@tuti/db";
import { commentEmail, sendEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";

import { cappedProjects, claimProjectEmail, dueAgain, heldDueDates, releaseProjectEmail } from "./email-limits";
import { portalPostUrl } from "./events";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { portalAddress } from "./portal-address";
import { postAudience, seenAs } from "./post-audience";
import { projectEmailWaits, projectSender } from "./project-sender";
import { claim, LATE_MINUTES, quotedText, whileClaimed } from "./reply-email";

/**
 * How long someone else's comment waits before it's emailed to the post's author (Comment.authorEmailDueAt): the
 * comments on a post within this of its first go in one email, so a quick back-and-forth is one email, not five.
 */
export const COMMENT_BATCH_MINUTES = 5;
/** After a day, a comment isn't news: one due a day ago and still not sent (its runs kept failing) is dropped. */
const LOOK_BACK_HOURS = 24;
const lookBack = () => new Date(Date.now() - LOOK_BACK_HOURS * 3_600_000);

/**
 * Emails a post's author the comments others wrote on it that are due, in one email (comment-email): only as
 * postAudience has who may be told (their "Posts I wrote" switch, the project's unsubscribe), with the project's
 * sender, limits and pause. A comment already emailed to them (the team's reply to voters, a run before) isn't again:
 * its claim (reply_email) is per comment and person, whichever email took it.
 */
export async function commentsEmailed({ postId }: JobInput<"commentsEmailed">, log: JobLogger): Promise<JobResult> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      number: true,
      title: true,
      status: true,
      voteCount: true,
      sample: true,
      authorId: true,
      visibility: true,
      board: { select: { slug: true, off: true } },
      projectId: true,
      project: { select: { name: true, slug: true, portalAccess: true, plan: true, brandColor: true } },
      comments: {
        where: { authorEmailDueAt: { not: null } },
        orderBy: { createdAt: "asc" },
        select: { id: true, authorId: true, body: true, content: true, author: { select: { name: true } } },
      },
    },
  });
  // What's past the look-back the cron dropped before queueing this (commentEmailsDue).
  const comments = post?.comments ?? [];
  if (!post || comments.length === 0) {
    return { skipped: true };
  }
  // Sample content (Home's "Add sample content") never emails anyone: not due any more.
  if (post.sample) {
    await prisma.comment.updateMany({ where: { postId, authorEmailDueAt: { not: null } }, data: { authorEmailDueAt: null } });
    return { skipped: true };
  }
  const { projectId, project } = post;
  const ids = comments.map((comment) => comment.id);
  // Done once no email about them to the author is left in flight (another run's, or the reply's to voters): the cron
  // takes one that is again later, and its claim says whether it went. Other people's claims (a voter's) aren't this one's.
  const done = (authorId: string | null) =>
    prisma.comment.updateMany({ where: { id: { in: ids }, ...(authorId && { replyEmails: { none: { userId: authorId, sentAt: null } } }) }, data: { authorEmailDueAt: null } });
  // The project's email is paused: still due, till the resume drops it (apps/web/src/server/email-pause.ts).
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const [author] = post.authorId ? await postAudience(projectId, project, post, [post.authorId]) : [];
  if (!author) {
    await done(null);
    return { emailed: 0 };
  }
  // Each comment claimed before sending (one time for all, as whileClaimed renews them), so a retry, a second run or the
  // reply's email to voters doesn't email it twice. Their own comments never become due; left out all the same.
  const claimedAt = new Date();
  const claimed: typeof comments = [];
  for (const comment of comments) {
    if (comment.authorId !== author.id && (await claim(comment.id, author.id, seenAs(post), "authorEmailDueAt", claimedAt))) {
      claimed.push(comment);
    }
  }
  if (claimed.length === 0) {
    await done(author.id);
    return { emailed: 0 };
  }
  const claimedIds = claimed.map((comment) => comment.id);
  // A new project's daily cap, the month's limit (and a pause since the run began): let go, and due when it resets.
  const now = new Date();
  if (!(await claimProjectEmail(projectId, now))) {
    await prisma.replyEmail.deleteMany({ where: { commentId: { in: claimedIds }, userId: author.id, claimedAt } });
    await prisma.comment.updateMany({ where: { id: { in: ids }, authorEmailDueAt: { not: null } }, data: { authorEmailDueAt: await dueAgain(projectId) } });
    return { emailed: 0, waiting: "the project's daily cap, its monthly limit, or a pause" };
  }
  const origin = await portalAddress(project.slug);
  const sender = await projectSender(projectId);
  const token = encodeURIComponent(author.unsubscribeToken);
  const error = await whileClaimed(claimedIds, author.id, claimedAt, () =>
    sendEmail({
      to: author.address,
      ...commentEmail({
        projectName: project.name,
        postTitle: post.title,
        voteCount: post.voteCount,
        status: post.status,
        comments: claimed.map((comment) => ({ authorId: comment.authorId, authorName: comment.author.name, text: quotedText(comment) })),
        postUrl: portalPostUrl(origin, post),
        unsubscribeUrl: `${origin}/unsubscribe?token=${token}`,
        accent: project.brandColor,
      }),
      ...sender,
      // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
      headers: { ...sender.headers, "List-Unsubscribe": `<${origin}/unsubscribe/confirm?token=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  );
  if (error) {
    // Still due, the claims released: Hatchet's retry (or the cron, once late) takes them over. What the monthly limit
    // held is due from now instead, so it's retried within the look-back like any other failure, not every run for good.
    await releaseProjectEmail(projectId, now);
    await prisma.comment.updateMany({ where: { id: { in: ids }, authorEmailDueAt: { in: heldDueDates() } }, data: { authorEmailDueAt: new Date() } });
    throw new Error(`couldn't email post ${postId}'s new comments to its author: ${error.message}`);
  }
  await done(author.id);
  log.info(`post ${postId}: emailed ${claimed.length} comment(s) to its author`);
  return { emailed: 1, comments: claimed.length };
}

/**
 * Every minute: queues comments-emailed for each post with a comment to its author that's due (its batch's wait is
 * over, a run failed or died, or what a limit held is due again). Not a paused project's: the resume drops them. Queued,
 * it isn't queued again for as long as a claim may be (authorEmailQueuedAt), so a run still going or waiting to start
 * isn't queued every minute; one that dies is taken again then (claims keep anyone from being emailed twice).
 */
export async function commentEmailsDue(_input: JobInput<"commentEmailsDue">, log: JobLogger): Promise<JobResult> {
  const now = new Date();
  const notPaused = plansEnabled() && { project: { emailPausedAt: null } };
  // Due for a day and still not sent (its runs kept failing): not news any more, so dropped, never sent with a newer
  // comment's email. Not what the monthly limit holds (heldDueDates: due at a month's first instant), whenever that's
  // due, as reply-emails-resubmit takes it; a run that fails makes that due from then (commentsEmailed).
  await prisma.comment.updateMany({
    where: { authorEmailDueAt: { lt: lookBack(), notIn: heldDueDates(now) }, ...notPaused },
    data: { authorEmailDueAt: null },
  });
  // Nor sample content's, ever (it never has effects outside).
  await prisma.comment.updateMany({ where: { authorEmailDueAt: { not: null }, post: { sample: true } }, data: { authorEmailDueAt: null } });
  const queuedLate = new Date(now.getTime() - LATE_MINUTES * 60_000);
  // Due, or held by the monthly limit (heldDueDates) where the project has room again (an upgrade), as
  // reply-emails-resubmit takes it: not a capped project's, which would only wait again.
  const capped = await cappedProjects(now);
  const waiting = {
    OR: [{ authorEmailDueAt: { lte: now } }, { authorEmailDueAt: { in: heldDueDates(now) }, ...(capped.length > 0 && { projectId: { notIn: capped } }) }],
    AND: [{ OR: [{ authorEmailQueuedAt: null }, { authorEmailQueuedAt: { lt: queuedLate } }] }],
  };
  const due = await prisma.comment.findMany({
    where: { ...waiting, ...notPaused },
    distinct: ["postId"],
    orderBy: { authorEmailDueAt: "asc" },
    select: { postId: true },
    take: 500,
  });
  let queued = 0;
  for (const { postId } of due) {
    await prisma.comment.updateMany({ where: { postId, ...waiting }, data: { authorEmailQueuedAt: now } });
    try {
      await enqueue("commentsEmailed", { postId });
      queued++;
    } catch (error) {
      log.warn(`couldn't queue post ${postId}'s comment emails: ${(error as Error).message}`);
    }
  }
  return { found: due.length, queued };
}
