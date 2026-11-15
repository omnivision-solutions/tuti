import { type PostStatus, type PostVisibility, type Prisma, prisma } from "@tuti/db";
import { type ProgressStatus, sendEmail, shippedEmail, statusEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";
import { statusMoveEmails } from "@tuti/shared/status-emails";

import { portalPostUrl } from "./events";
import { postAudience, SEEN_AS_SQL, seenAs, visibilityChanged } from "./post-audience";
import { portalAddress } from "./portal-address";
import { cappedProjects, claimProjectEmail, dueAgain, heldDueDates, monthCappedProjects, nextMonth, releaseProjectEmail, tellEmailLimit, tomorrow } from "./email-limits";
import { emailBrand } from "./email-brand";
import { projectEmailWaits, projectSender } from "./project-sender";
import { enqueue, type JobLogger, type JobResult } from "./index";

/** An unsent claim (or a due post) this old belongs to a run that died or never started. */
const LATE_MINUTES = 10;
/** After a day, a post's emails aren't news anymore. */
const RESUBMIT_FOR_HOURS = 24;

/** Well under LATE_MINUTES, so a live run's claim never looks abandoned. */
const RENEW_MS = 60_000;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

/** The statuses a post's people hear about: Planned and In progress (statusEmail), and Completed (shippedEmail). */
const EMAILED: PostStatus[] = ["PLANNED", "IN_PROGRESS", "COMPLETED"];

/**
 * Where one status's claims live: Completed's in shipped_email (once per post and person), Planned's and In progress's
 * in status_email (once per post, person and status). Both have the same columns but `status`, so one delegate's type
 * serves both, and `key` (spread into every where and create) picks the status on status_email.
 */
function claims(db: Prisma.TransactionClient, status: PostStatus) {
  // ponytail: shipped_email cast to status_email's delegate; `key` is empty for it, so no `status` ever reaches it.
  const table = (status === "COMPLETED" ? db.shippedEmail : db.statusEmail) as unknown as Prisma.TransactionClient["statusEmail"];
  const key = (status === "COMPLETED" ? {} : { status }) as { status: PostStatus };
  return { table, key };
}

/**
 * Takes on emailing one person: a new claim, or one a crashed run left unsent.
 * Returns the claim's time, which the run then uses to mark it sent or release
 * it (so it never touches a claim another run took over); null when someone else
 * has it or it's sent.
 */
async function claim(postId: string, userId: string, status: PostStatus, visibility: PostVisibility): Promise<Date | null> {
  return prisma.$transaction(async (tx) => {
    // Only while it still has the status it's emailed about and its emails are due: the post's row locked, so a status change (Undo, say) or a
    // resume that drops a pause's emails waits for this claim, or this claim sees it and emails nobody else. One claimed
    // already may still go. A visibility change since the audience was read (under the same lock) fails the run: its
    // retry reads who may see it now.
    // Its board's row held first (as deleting a board locks it, then its posts): turning the board off waits for this
    // claim, or this claim sees it off. Moved to another board meanwhile, it's read again (the run's retry).
    const [board] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM board WHERE id = (SELECT "boardId" FROM post WHERE id = ${postId}) FOR SHARE`;
    const [post] = await tx.$queryRaw<{ status: string; due: Date | null; visibility: PostVisibility; boardId: string }[]>`
      SELECT status, "shippedEmailsDueAt" AS due, ${SEEN_AS_SQL} AS visibility, "boardId" FROM post WHERE id = ${postId} FOR UPDATE`;
    if (post?.status !== status || post.due === null) {
      return null;
    }
    if (post.visibility !== visibility || post.boardId !== board?.id) {
      throw visibilityChanged(postId);
    }
    // For this change (its activity counts who it reached), read under the same lock.
    const change = await tx.postEvent.findFirst({ where: { postId, to: status }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const eventId = change?.id ?? null;
    const claimedAt = new Date();
    const { table, key } = claims(tx, status);
    const { count } = await table.createMany({ data: [{ postId, userId, claimedAt, eventId, ...key }], skipDuplicates: true });
    if (count === 1) {
      return claimedAt;
    }
    const taken = await table.updateMany({
      where: { postId, userId, ...key, sentAt: null, claimedAt: { lt: late() } },
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
async function whileClaimed(claim: { postId: string; userId: string; status: PostStatus; claimedAt: Date }, send: () => Promise<unknown>) {
  const { postId, userId } = claim;
  const { table, key } = claims(prisma, claim.status);
  let current = claim.claimedAt;
  let renewing = Promise.resolve();
  const renew = async () => {
    const next = new Date();
    const { count } = await table.updateMany({ where: { postId, userId, ...key, claimedAt: current }, data: { claimedAt: next } });
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
  const mine = { postId, userId, ...key, claimedAt: current };
  if (error) {
    // Released as stale, not deleted: still unsent, so another run finishing meanwhile doesn't take the post as done
    // (and clear its due time, which the retry needs), and the retry takes it over.
    await table.updateMany({ where: mine, data: { claimedAt: new Date(0) } });
    return error;
  }
  // Sent: never released from here on. If saving this fails, the claim stays unsent and is
  // taken over later, which may email them twice; better than not at all.
  // Counted on its status change in the same write: only by the run that marks it sent, once.
  await prisma.$transaction(async (tx) => {
    const { table, key } = claims(tx, claim.status);
    const { count } = await table.updateMany({ where: mine, data: { sentAt: new Date() } });
    const sent = count === 1 ? await table.findFirst({ where: { postId, userId, ...key }, select: { eventId: true } }) : null;
    if (sent?.eventId) {
      await tx.postEvent.update({ where: { id: sent.eventId }, data: { emailed: { increment: 1 } } });
    }
  });
  return null;
}

/** How long before a post was completed the review that completed it may have been approved (its claim comes first). */
const NOTE_WINDOW_MS = 10 * 60_000;

/**
 * A post moved to Planned, In progress or Completed: emails its author, voters, commenters and subscribers about the
 * status it has now (as postAudience has who may be told), each once per status: that it shipped (shippedEmail), or
 * the progress (statusEmail).
 */
export async function postShipped({ postId }: JobInput<"postShipped">, log: JobLogger): Promise<JobResult> {
  // Only while it still has a status its people hear about (the team may have reopened it since) and not merged away;
  // never for sample content (Home's "Add sample content"), whatever moved it.
  const post = await prisma.post.findFirst({
    // Only while its emails are due: a resume drops a pause's (apps/web/src/server/email-pause.ts), even a retry's.
    where: { id: postId, status: { in: EMAILED }, duplicateOfId: null, sample: false, shippedEmailsDueAt: { not: null } },
    select: {
      number: true,
      title: true,
      status: true,
      voteCount: true,
      board: { select: { slug: true, off: true, name: true } },
      projectId: true,
      authorId: true,
      visibility: true,
      project: { select: { name: true, slug: true, portalAccess: true, plan: true, brandColor: true } },
      votes: { select: { userId: true } },
      comments: { select: { authorId: true } },
      subscriptions: { select: { userId: true } },
    },
  });
  if (!post) {
    await prisma.post.updateMany({ where: { id: postId }, data: { shippedEmailsDueAt: null } });
    return { skipped: true };
  }
  const { projectId, project, status } = post;
  const { table, key } = claims(prisma, status);
  // Planned and In progress only as the move that set it was one forward (statusMoveEmails), checked here too: a due
  // time a move back left (the previous release's, during a deploy) emails nobody about it.
  if (status !== "COMPLETED") {
    const moved = await prisma.postEvent.findFirst({ where: { postId, to: status }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { from: true } });
    if (!moved || statusMoveEmails(moved.from, status) !== "progress") {
      await prisma.post.updateMany({ where: { id: postId, status }, data: { shippedEmailsDueAt: null } });
      return { skipped: true };
    }
  }
  // The project's email is paused: still due, till the resume drops it (apps/web/src/server/email-pause.ts).
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const everyone = await postAudience(projectId, project, post, [
    post.authorId,
    ...post.votes.map((v) => v.userId),
    ...post.comments.map((c) => c.authorId),
    ...post.subscriptions.map((s) => s.userId),
  ]);
  // Planned and In progress promise an email when it ships: not for people told it shipped already (reopened since).
  const shippedTo =
    status === "COMPLETED" ? new Set<string>() : new Set((await prisma.shippedEmail.findMany({ where: { postId, sentAt: { not: null } }, select: { userId: true } })).map(({ userId }) => userId));
  const people = everyone.filter((person) => !shippedTo.has(person.id));
  // Claims a failed or crashed try left unsent for people it won't email now (they unsubscribed, a private portal
  // that's the team's only): dropped, so the post isn't due again and again. A run still sending keeps its claim (not
  // stale yet), so it can mark it sent. The few stale claims are read and checked here: no list of the whole audience
  // goes into a query.
  const audience = new Set(people.map((person) => person.id));
  const stale = await table.findMany({ where: { postId, ...key, sentAt: null, claimedAt: { lt: late() } }, select: { userId: true } });
  const gone = stale.map(({ userId }) => userId).filter((userId) => !audience.has(userId));
  if (gone.length > 0) {
    await table.deleteMany({ where: { postId, ...key, sentAt: null, claimedAt: { lt: late() }, userId: { in: gone } } });
  }

  // The team's comment Autopilot's review posted with the change (its update's `note`): quoted. Only that one,
  // never a comment that merely came before a change by hand. Autopilot completes posts and moves them to In progress,
  // never to Planned.
  const completed = await prisma.postEvent.findFirst({ where: { postId, to: status }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  // Approved since the post's status last changed before this completion: an older one (completed, reopened, then
  // completed by hand) isn't this completion's.
  const before = completed && (await prisma.postEvent.findFirst({ where: { postId, createdAt: { lt: completed.createdAt } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }));
  const since = new Date(Math.max(completed ? completed.createdAt.getTime() - NOTE_WINDOW_MS : 0, before ? before.createdAt.getTime() + 1 : 0));
  const update =
    completed && status !== "PLANNED"
      ? await prisma.codeChangeAction.findFirst({
          where: { postId, kind: status === "COMPLETED" ? "RESOLVES" : "MOVES_FORWARD", status: "APPLIED", decidedAt: { gte: since, lte: completed.createdAt } },
          orderBy: { decidedAt: "desc" },
          select: { payload: true },
        })
      : null;
  const noteId = (update?.payload as { note?: unknown } | null)?.note;
  const comment =
    typeof noteId === "string" ? await prisma.comment.findFirst({ where: { id: noteId, postId }, select: { body: true, author: { select: { name: true } } } }) : null;
  const note = comment?.body.trim() ? { from: comment.author.name, text: comment.body.trim() } : undefined;

  const origin = await portalAddress(project.slug);
  const [sender, brand] = await Promise.all([projectSender(projectId), emailBrand(projectId)]);
  const postUrl = portalPostUrl(origin, post);
  let emailed = 0;
  let failed = 0;
  let held = false;
  for (const { id, address, unsubscribeToken } of people) {
    // Claimed before sending, so a retry, a second run or the post moved there again doesn't email them twice.
    const claimedAt = await claim(postId, id, status, seenAs(post));
    if (!claimedAt) {
      continue;
    }
    // A new project's daily cap and the month's limit, taken once they're ours to email (and a pause since the run began):
    // past it, they're let go and wait.
    const now = new Date();
    if (!(await claimProjectEmail(projectId, now))) {
      await table.deleteMany({ where: { postId, userId: id, ...key, claimedAt } });
      held = true;
      break;
    }
    const token = encodeURIComponent(unsubscribeToken);
    const unsubscribeUrl = `${origin}/unsubscribe?token=${token}`;
    const error = await whileClaimed({ postId, userId: id, status, claimedAt }, () =>
      sendEmail({
        to: address,
        ...(status === "COMPLETED"
          ? shippedEmail({ ...brand, postTitle: post.title, postUrl, unsubscribeUrl, note })
          : statusEmail({ ...brand, status: status as ProgressStatus, postTitle: post.title, boardName: post.board.name, votes: post.voteCount, postUrl, unsubscribeUrl, note })),
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
      await releaseProjectEmail(projectId, now);
      log.warn(`couldn't email that post ${postId} shipped: ${error.message}`);
      continue;
    }
    emailed++;
  }
  if (failed > 0) {
    // Held for a month (dueAgain), the safety nets would take it every run, for good: due from now instead, so it's retried
    // like any other failure, within their look-back.
    await prisma.post.updateMany({ where: { id: postId, shippedEmailsDueAt: { in: heldDueDates() } }, data: { shippedEmailsDueAt: new Date() } });
    throw new Error(`${failed} shipped email(s) for post ${postId} failed; retrying those`);
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back a day) until the rest may go; past the month's limit, from next month.
    await prisma.post.updateMany({ where: { id: postId, shippedEmailsDueAt: { not: null } }, data: { shippedEmailsDueAt: await dueAgain(projectId) } });
    log.info(`post ${postId} (${status}): emailed ${emailed}, the rest wait (the project's daily cap, its monthly limit, or a pause)`);
    return { emailed, waiting: "the project's daily cap, its monthly limit, or a pause" };
  }
  // Done once nobody's email is left in flight: if another run is still sending one and dies, the cron needs to find this post.
  // Only while it still has this status: moved on since, it's due for the next one's emails (its own run clears it).
  await prisma.post.updateMany({
    where: { id: postId, status, ...(status === "COMPLETED" ? { shippedEmails: { none: { sentAt: null } } } : { statusEmails: { none: { status, sentAt: null } } }) },
    data: { shippedEmailsDueAt: null },
  });
  log.info(`post ${postId} (${status}): emailed ${emailed}`);
  return { emailed };
}

/**
 * The safety net: a post whose emails are still due after a while (its job was
 * never queued, or died mid-send) gets its job again. Claims keep that from emailing anyone twice.
 */
export async function resubmitShippedEmails(_input: JobInput<"resubmitShippedEmails">, log: JobLogger): Promise<JobResult> {
  // A project whose month is full: what's due now waits for next month, where these find it (a job that never ran
  // would otherwise leave it here, past the look-back, for good).
  const full = await monthCappedProjects();
  if (full.length > 0) {
    // Not a paused one's: what the pause holds, its resume lets go (or drops).
    // Nor sample content, which never has effects outside (the team's notice included).
    const moving = { projectId: { in: full }, project: { emailPausedAt: null }, sample: false, shippedEmailsDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } };
    const projects = await prisma.post.findMany({ where: moving, distinct: ["projectId"], select: { projectId: true } });
    await prisma.post.updateMany({ where: moving, data: { shippedEmailsDueAt: nextMonth(new Date()) } });
    // Their teams hear (once a month), as when a claim is refused.
    for (const { projectId } of projects) {
      await tellEmailLimit(projectId, new Date());
    }
  }
  const capped = await cappedProjects();
  // A new project past its daily cap: what's due now (its job never ran) is due when the cap resets, as what a run held
  // is (dueAgain), so it's still within the look-back then.
  const daily = capped.filter((id) => !full.includes(id));
  if (daily.length > 0) {
    await prisma.post.updateMany({
      where: { projectId: { in: daily }, project: { emailPausedAt: null }, shippedEmailsDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } },
      data: { shippedEmailsDueAt: tomorrow(new Date()) },
    });
  }
  const due = await prisma.post.findMany({
    where: {
      // Due a while ago, or held by the monthly limit (dueAgain): once its month has reset, or now where the project has room again (an upgrade).
      OR: [{ shippedEmailsDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } }, { shippedEmailsDueAt: { in: heldDueDates() } }],
      // Not a capped project's (its month full, or a new one's daily cap): it'd wait again. What they hold is due when
      // the cap resets (dueAgain), within the look-back then.
      ...(capped.length > 0 && { projectId: { notIn: capped } }),
      // Not a paused project's: they'd wait again, and fill the batch before ones that can go.
      ...(plansEnabled() && { project: { emailPausedAt: null } }),
    },
    orderBy: { shippedEmailsDueAt: "asc" },
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
