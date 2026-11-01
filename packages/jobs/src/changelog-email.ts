import { type Doc, emailImageKey, fromPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";
import { changelogEmail, sendEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";

import { cappedProjects, claimProjectEmail } from "./email-limits";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { lastingMediaUrl, lastingMediaUrls } from "./lasting-media";
import { portalAddress } from "./portal-address";
import { projectEmailWaits, projectSender } from "./project-sender";

/** An unsent claim (or a due entry) this old belongs to a run that died or never started. */
const LATE_MINUTES = 10;
/** After a day, an entry's emails aren't news anymore. */
const RESUBMIT_FOR_HOURS = 24;
/** Well under LATE_MINUTES, so a live run's claim never looks abandoned. */
const RENEW_MS = 60_000;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

type Db = Pick<typeof prisma, "changelogSubscriber" | "user">;

/**
 * Who an entry goes to: the project's subscribers confirmed by the time it was published with Email subscribers
 * (`emailedAt`), past anyone who turned the project's emails off ("Unsubscribe" in a shipped email, say). Oldest first.
 * `only`: just this one (as they are now, in a claim's transaction).
 */
async function audience(projectId: string, emailedAt: Date, only?: string, db: Db = prisma) {
  const subscribers = await db.changelogSubscriber.findMany({
    where: { projectId, confirmedAt: { not: null, lte: emailedAt }, ...(only && { id: only }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, email: true, token: true },
  });
  const optedOut = new Set(
    (
      await db.user.findMany({
        where: { emailOptOuts: { some: { projectId } }, email: { in: subscribers.map((s) => s.email), mode: "insensitive" } },
        select: { email: true },
      })
    ).map((user) => user.email.toLowerCase()),
  );
  return subscribers.filter((s) => !optedOut.has(s.email));
}

/**
 * Takes on emailing one subscriber, while they still want it: their consent read again now, with their row locked
 * (so unsubscribing waits for this, or this sees it), not as the run's list had it. A new claim, or one a crashed run
 * left unsent. Returns the claim's time, which the run then uses to mark it sent or release it (never touching a claim
 * another run took over); null when they don't want it any more, someone else has it, or it's sent.
 */
async function claim(entry: { id: string; projectId: string; emailedAt: Date }, subscriberId: string): Promise<Date | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "changelog_subscriber" WHERE "id" = ${subscriberId} FOR UPDATE`;
    if ((await audience(entry.projectId, entry.emailedAt, subscriberId, tx)).length === 0) {
      return null;
    }
    const entryId = entry.id;
    const claimedAt = new Date();
    const { count } = await tx.changelogEmail.createMany({ data: [{ entryId, subscriberId, claimedAt }], skipDuplicates: true });
    if (count === 1) {
      return claimedAt;
    }
    const taken = await tx.changelogEmail.updateMany({ where: { entryId, subscriberId, sentAt: null, claimedAt: { lt: late() } }, data: { claimedAt } });
    return taken.count === 1 ? claimedAt : null;
  });
}

/**
 * Sends while holding a claim, renewing it every minute meanwhile, then marks it sent, or (the send failed)
 * releases it for a retry. Both touch only this run's claim. Returns the send's error, if any.
 */
async function whileClaimed(entryId: string, subscriberId: string, claimedAt: Date, send: () => Promise<unknown>) {
  let current = claimedAt;
  let renewing = Promise.resolve();
  const renew = async () => {
    const next = new Date();
    const { count } = await prisma.changelogEmail.updateMany({ where: { entryId, subscriberId, claimedAt: current }, data: { claimedAt: next } });
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
  const mine = { entryId, subscriberId, claimedAt: current };
  if (error) {
    await prisma.changelogEmail.deleteMany({ where: mine });
    return error;
  }
  // Sent: never released from here on. If saving this fails, the claim stays unsent and is taken over later,
  // which may email them twice; better than not at all.
  await prisma.changelogEmail.updateMany({ where: mine, data: { sentAt: new Date() } });
  return null;
}

/** Lasting links to the entry's images and its cover's email JPEG; none when the worker can't sign them. */
function entryImages(doc: Doc, coverId: string | null, log: JobLogger) {
  try {
    const mediaUrls = lastingMediaUrls(doc);
    return { mediaUrls, coverUrl: mediaUrls && coverId ? lastingMediaUrl(emailImageKey(coverId)) : null };
  } catch (error) {
    log.warn(`changelog emails go without their images (set APP_URL and BETTER_AUTH_SECRET on the worker): ${(error as Error).message}`);
    return { mediaUrls: null, coverUrl: null };
  }
}

/**
 * A changelog entry was published with Email subscribers: emails it to the project's subscribers who had confirmed
 * by then, each once, with the project's sender, daily cap and pause. Not to anyone who turned the project's emails
 * off (the unsubscribe link in its other emails), and never from a private portal (its subscribers may not be readers).
 */
export async function changelogEmailed({ entryId }: JobInput<"changelogEmailed">, log: JobLogger): Promise<JobResult> {
  const entry = await prisma.changelogEntry.findUnique({
    where: { id: entryId },
    select: {
      number: true,
      title: true,
      content: true,
      body: true,
      coverId: true,
      cover: { select: { status: true } },
      publishedAt: true,
      subscribersEmailedAt: true,
      subscribersEmailDueAt: true,
      projectId: true,
      project: { select: { name: true, slug: true, portalAccess: true } },
    },
  });
  // Not due (sent, never asked for), or on a private portal (since it was published).
  if (!entry?.subscribersEmailDueAt || !entry.subscribersEmailedAt || entry.project.portalAccess === "PRIVATE") {
    await prisma.changelogEntry.updateMany({ where: { id: entryId }, data: { subscribersEmailDueAt: null } });
    return { skipped: true };
  }
  // Taken off the portal meanwhile: still due, so publishing it again sends the rest.
  if (!entry.publishedAt) {
    return { waiting: "the entry isn't published" };
  }
  const { projectId, project } = entry;
  // The project's email is paused: still due, so the cron brings it back (for a day) once it's resumed.
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const emailedAt = entry.subscribersEmailedAt;
  const people = await audience(projectId, emailedAt);
  // Claims a crashed try left unsent for people no longer to be emailed (unsubscribed since) are dropped,
  // so they don't keep the entry due. A run still sending keeps its claim (not stale yet).
  await prisma.changelogEmail.deleteMany({ where: { entryId, sentAt: null, claimedAt: { lt: late() }, subscriberId: { notIn: people.map((p) => p.id) } } });

  const origin = await portalAddress(project.slug);
  const sender = await projectSender(projectId);
  const entryUrl = `${origin}/changelog/${entry.number}`;
  const doc = (entry.content as Doc | null) ?? fromPlainText(entry.body);
  const images = entryImages(doc, entry.cover?.status === "READY" ? entry.coverId : null, log);
  let emailed = 0;
  let failed = 0;
  let held = false;
  for (const { id, email, token } of people) {
    // Claimed before sending, so a retry or a second run doesn't email them twice.
    const claimedAt = await claim({ id: entryId, projectId, emailedAt }, id);
    if (!claimedAt) {
      continue;
    }
    // A new project's daily cap (and a pause since the run began): past it, they're let go and wait.
    if (!(await claimProjectEmail(projectId))) {
      await prisma.changelogEmail.deleteMany({ where: { entryId, subscriberId: id, claimedAt } });
      held = true;
      break;
    }
    const query = `token=${encodeURIComponent(token)}`;
    const error = await whileClaimed(entryId, id, claimedAt, () =>
      sendEmail({
        to: email,
        ...changelogEmail({
          projectName: project.name,
          entryTitle: entry.title,
          entryUrl,
          doc,
          ...images,
          unsubscribeUrl: `${origin}/changelog/subscription?${query}`,
        }),
        ...sender,
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: { ...sender.headers, "List-Unsubscribe": `<${origin}/changelog/subscription/unsubscribe?${query}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    );
    if (error) {
      failed++;
      log.warn(`couldn't email changelog entry ${entryId} to a subscriber: ${error.message}`);
      continue;
    }
    emailed++;
  }
  if (failed > 0) {
    throw new Error(`${failed} changelog email(s) for entry ${entryId} failed; retrying those`);
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back a day) until the rest may go.
    await prisma.changelogEntry.updateMany({ where: { id: entryId, subscribersEmailDueAt: { not: null } }, data: { subscribersEmailDueAt: new Date() } });
    return { emailed, waiting: "the project's daily cap, or a pause" };
  }
  // Done once everyone it's for (as they are now) has it. Not from the claims: one another run held (and so this run
  // skipped) may be let go since, past the cap; then its subscriber has none, and would be left out for good.
  const sent = new Set(
    (await prisma.changelogEmail.findMany({ where: { entryId, sentAt: { not: null } }, select: { subscriberId: true } })).map((e) => e.subscriberId),
  );
  const left = (await audience(projectId, emailedAt)).filter((s) => !sent.has(s.id)).length;
  if (left > 0) {
    log.info(`changelog entry ${entryId}: emailed ${emailed} subscriber(s), ${left} left (another run has them, or let them go)`);
    return { emailed, left };
  }
  await prisma.changelogEntry.updateMany({ where: { id: entryId }, data: { subscribersEmailDueAt: null } });
  log.info(`changelog entry ${entryId}: emailed ${emailed} subscriber(s)`);
  return { emailed };
}

/** The safety net: an entry whose emails are still due after a while gets its job again. Claims keep that from emailing anyone twice. */
export async function resubmitChangelogEmails(_input: JobInput<"resubmitChangelogEmails">, log: JobLogger): Promise<JobResult> {
  // Not a paused project's, nor a new one's past its daily cap: they'd wait again. The longest due first.
  const capped = await cappedProjects();
  const due = await prisma.changelogEntry.findMany({
    where: {
      subscribersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) },
      // One taken off the portal waits to be published again (which queues it).
      publishedAt: { not: null },
      ...(plansEnabled() && { project: { emailPausedAt: null } }),
      ...(capped.length > 0 && { projectId: { notIn: capped } }),
    },
    orderBy: { subscribersEmailDueAt: "asc" },
    select: { id: true },
    take: 500,
  });
  let queued = 0;
  for (const entry of due) {
    try {
      await enqueue("changelogEmailed", { entryId: entry.id });
      queued++;
    } catch (error) {
      log.warn(`couldn't queue changelog emails for entry ${entry.id} again: ${(error as Error).message}`);
    }
  }
  if (due.length > 0) {
    log.info(`queued changelog emails again for ${queued} of ${due.length} entries`);
  }
  return { found: due.length, queued };
}
