import { type Doc, toPlainText } from "@tuti/content";
import { type PostVisibility, prisma } from "@tuti/db";
import { replyEmail, sendEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";

import { cappedProjects, claimProjectEmail, dueAgain, monthCappedProjects, nextMonth, releaseProjectEmail } from "./email-limits";
import { portalPostUrl } from "./events";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { lastingMediaUrls } from "./lasting-media";
import { portalAddress } from "./portal-address";
import { postAudience, SEEN_AS_SQL, seenAs, visibilityChanged } from "./post-audience";
import { projectEmailWaits, projectSender } from "./project-sender";

/** An unsent claim (or a due reply) this old belongs to a run that died or never started. */
const LATE_MINUTES = 10;
/** After a day, a reply's emails aren't news anymore. */
const RESUBMIT_FOR_HOURS = 24;
/** Well under LATE_MINUTES, so a live run's claim never looks abandoned. */
const RENEW_MS = 60_000;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

/**
 * Takes on emailing one voter: a new claim, or one a crashed run left unsent. Returns the claim's time, which the
 * run then uses to mark it sent or release it (never touching a claim another run took over); null when someone
 * else has it, it's sent, or the reply's emails aren't due any more (a resume dropped a pause's).
 */
async function claim(commentId: string, userId: string, visibility: PostVisibility): Promise<Date | null> {
  return prisma.$transaction(async (tx) => {
    // Its post's row held first (as a merge locks posts, then their comments): a visibility change since the audience
    // was read fails the run (its retry reads who may see it now), and one made meanwhile waits for this claim.
    // Before it, its board's row (as deleting a board locks it, then its posts): turning the board off waits for this
    // claim, or this claim sees it off. Moved to another board meanwhile, it's read again (the run's retry).
    const [board] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM board WHERE id = (SELECT p."boardId" FROM post p JOIN comment c ON c."postId" = p.id WHERE c.id = ${commentId}) FOR SHARE`;
    const [post] = await tx.$queryRaw<{ id: string; visibility: PostVisibility; boardId: string }[]>`
      SELECT id, ${SEEN_AS_SQL} AS visibility, "boardId" FROM post WHERE id = (SELECT "postId" FROM comment WHERE id = ${commentId}) FOR SHARE`;
    // The reply's row locked, so a resume that drops a pause's emails waits for this claim, or this claim sees it.
    const [comment] = await tx.$queryRaw<{ due: Date | null }[]>`SELECT "votersEmailDueAt" AS due FROM comment WHERE id = ${commentId} FOR UPDATE`;
    if (!comment?.due || !post) {
      return null;
    }
    if (post.visibility !== visibility || post.boardId !== board?.id) {
      throw visibilityChanged(post.id);
    }
    const claimedAt = new Date();
    const { count } = await tx.replyEmail.createMany({ data: [{ commentId, userId, claimedAt }], skipDuplicates: true });
    if (count === 1) {
      return claimedAt;
    }
    const taken = await tx.replyEmail.updateMany({ where: { commentId, userId, sentAt: null, claimedAt: { lt: late() } }, data: { claimedAt } });
    return taken.count === 1 ? claimedAt : null;
  });
}

/**
 * Sends while holding a claim, renewing it every minute meanwhile, then marks it sent, or (the send failed)
 * releases it for a retry. Both touch only this run's claim. Returns the send's error, if any.
 */
async function whileClaimed(commentId: string, userId: string, claimedAt: Date, send: () => Promise<unknown>) {
  let current = claimedAt;
  let renewing = Promise.resolve();
  const renew = async () => {
    const next = new Date();
    const { count } = await prisma.replyEmail.updateMany({ where: { commentId, userId, claimedAt: current }, data: { claimedAt: next } });
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
  const mine = { commentId, userId, claimedAt: current };
  if (error) {
    // Released as stale, not deleted: still unsent, so another run finishing meanwhile doesn't take the reply as done
    // (and clear its due time, which the retry needs), and the retry takes it over.
    await prisma.replyEmail.updateMany({ where: mine, data: { claimedAt: new Date(0) } });
    return error;
  }
  // Sent: never released from here on. If saving this fails, the claim stays unsent and is taken over later,
  // which may email them twice; better than not at all.
  await prisma.replyEmail.updateMany({ where: mine, data: { sentAt: new Date() } });
  return null;
}

/**
 * The team replied to a post with Email voters: emails its voters the reply (not the one who wrote it, and only
 * as postAudience has who may be told). Each once, with the project's sender, daily cap and pause.
 */
export async function replyEmailed({ commentId }: JobInput<"replyEmailed">, log: JobLogger): Promise<JobResult> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      authorId: true,
      body: true,
      content: true,
      votersEmailDueAt: true,
      author: { select: { name: true } },
      post: {
        select: {
          number: true,
          title: true,
          board: { select: { slug: true, off: true } },
          projectId: true,
          authorId: true,
          visibility: true,
          project: { select: { name: true, slug: true, portalAccess: true, plan: true, brandColor: true } },
          votes: { select: { userId: true } },
        },
      },
    },
  });
  // Not due (sent, never asked for, or its post merged into another since: the merge clears it).
  if (!comment?.votersEmailDueAt) {
    await prisma.comment.updateMany({ where: { id: commentId }, data: { votersEmailDueAt: null } });
    return { skipped: true };
  }
  const { post } = comment;
  const { projectId, project } = post;
  // The project's email is paused: still due, till the resume drops it (apps/web/src/server/email-pause.ts).
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const people = await postAudience(
    projectId,
    project,
    post,
    post.votes.map((vote) => vote.userId).filter((id) => id !== comment.authorId),
  );
  // Claims a crashed try left unsent for people no longer to be told (unsubscribed, joined the team since) are
  // dropped, so they don't keep the reply due. A run still sending keeps its claim (not stale yet).
  await prisma.replyEmail.deleteMany({ where: { commentId, sentAt: null, claimedAt: { lt: late() }, userId: { notIn: people.map((person) => person.id) } } });

  const origin = await portalAddress(project.slug);
  const sender = await projectSender(projectId);
  const postUrl = portalPostUrl(origin, post);
  const doc = (comment.content as Doc | null) ?? undefined;
  const mediaUrls = lastingMediaUrls(doc);
  // Quoted without its images' alt text: the images are shown under the quote.
  const text = doc ? toPlainText({ ...doc, content: doc.content?.filter((node) => node.type !== "image") }) : comment.body;
  let emailed = 0;
  let failed = 0;
  let held = false;
  for (const { id, address, unsubscribeToken } of people) {
    // Claimed before sending, so a retry or a second run doesn't email them twice.
    const claimedAt = await claim(commentId, id, seenAs(post));
    if (!claimedAt) {
      continue;
    }
    // A new project's daily cap, the month's limit (and a pause since the run began): past it, they're let go and wait.
    const now = new Date();
    if (!(await claimProjectEmail(projectId, now))) {
      await prisma.replyEmail.deleteMany({ where: { commentId, userId: id, claimedAt } });
      held = true;
      break;
    }
    const token = encodeURIComponent(unsubscribeToken);
    const error = await whileClaimed(commentId, id, claimedAt, () =>
      sendEmail({
        to: address,
        ...replyEmail({
          projectName: project.name,
          authorName: comment.author.name,
          postTitle: post.title,
          text,
          doc,
          mediaUrls,
          postUrl,
          unsubscribeUrl: `${origin}/unsubscribe?token=${token}`,
          accent: project.brandColor,
        }),
        ...sender,
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: { ...sender.headers, "List-Unsubscribe": `<${origin}/unsubscribe/confirm?token=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    );
    if (error) {
      failed++;
      await releaseProjectEmail(projectId, now);
      log.warn(`couldn't email reply ${commentId} to a voter: ${error.message}`);
      continue;
    }
    emailed++;
  }
  if (failed > 0) {
    throw new Error(`${failed} reply email(s) for comment ${commentId} failed; retrying those`);
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back a day) until the rest may go; past the month's limit, from next month.
    await prisma.comment.updateMany({ where: { id: commentId, votersEmailDueAt: { not: null } }, data: { votersEmailDueAt: await dueAgain(projectId) } });
    return { emailed, waiting: "the project's daily cap, its monthly limit, or a pause" };
  }
  // Done once nobody's email is left in flight: if another run is still sending one and dies, the cron finds it.
  await prisma.comment.updateMany({ where: { id: commentId, replyEmails: { none: { sentAt: null } } }, data: { votersEmailDueAt: null } });
  log.info(`reply ${commentId}: emailed ${emailed} voter(s)`);
  return { emailed };
}

/** The safety net: a reply whose emails are still due after a while gets its job again. Claims keep that from emailing anyone twice. */
export async function resubmitReplyEmails(_input: JobInput<"resubmitReplyEmails">, log: JobLogger): Promise<JobResult> {
  // Not a paused project's (projectEmailWaits), nor a new one's past its daily cap: they'd wait again, and fill
  // the batch before ones that can go. The longest due first.
  // A project whose month is full: what's due now waits for next month, where these find it (a job that never ran
  // would otherwise leave it here, past the look-back, for good).
  const full = await monthCappedProjects();
  if (full.length > 0) {
    await prisma.comment.updateMany({
      // Not a paused one's: what the pause holds, its resume lets go (or drops).
      where: { projectId: { in: full }, project: { emailPausedAt: null }, votersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } },
      data: { votersEmailDueAt: nextMonth(new Date()) },
    });
  }
  const capped = await cappedProjects();
  const due = await prisma.comment.findMany({
    where: {
      // Due a while ago, or held for next month by the monthly limit (dueAgain) where the project has room again (an upgrade).
      OR: [{ votersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } }, { votersEmailDueAt: nextMonth(new Date()) }],
      ...(plansEnabled() && { project: { emailPausedAt: null } }),
      ...(capped.length > 0 && { projectId: { notIn: capped } }),
    },
    orderBy: { votersEmailDueAt: "asc" },
    select: { id: true },
    take: 500,
  });
  let queued = 0;
  for (const comment of due) {
    try {
      await enqueue("replyEmailed", { commentId: comment.id });
      queued++;
    } catch (error) {
      log.warn(`couldn't queue reply emails for comment ${comment.id} again: ${(error as Error).message}`);
    }
  }
  if (due.length > 0) {
    log.info(`queued reply emails again for ${queued} of ${due.length} replies`);
  }
  return { found: due.length, queued };
}
