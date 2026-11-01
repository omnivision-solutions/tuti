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

/**
 * Takes on emailing one subscriber: a new claim, or one a crashed run left unsent. Returns the claim's time, which
 * the run then uses to mark it sent or release it (never touching a claim another run took over); null when someone
 * else has it or it's sent.
 */
async function claim(entryId: string, subscriberId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const { count } = await prisma.changelogEmail.createMany({ data: [{ entryId, subscriberId, claimedAt }], skipDuplicates: true });
  if (count === 1) {
    return claimedAt;
  }
  const taken = await prisma.changelogEmail.updateMany({ where: { entryId, subscriberId, sentAt: null, claimedAt: { lt: late() } }, data: { claimedAt } });
  return taken.count === 1 ? claimedAt : null;
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
  // Not due (sent, never asked for), taken off the portal since, or on a private portal.
  if (!entry?.subscribersEmailDueAt || !entry.subscribersEmailedAt || !entry.publishedAt || entry.project.portalAccess === "PRIVATE") {
    await prisma.changelogEntry.updateMany({ where: { id: entryId }, data: { subscribersEmailDueAt: null } });
    return { skipped: true };
  }
  const { projectId, project } = entry;
  // The project's email is paused: still due, so the cron brings it back (for a day) once it's resumed.
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const subscribers = await prisma.changelogSubscriber.findMany({
    where: { projectId, confirmedAt: { not: null, lte: entry.subscribersEmailedAt } },
    select: { id: true, email: true, token: true },
  });
  // People who turned the project's emails off ("Unsubscribe" in a shipped email, say) aren't emailed here either.
  const optedOut = new Set(
    (
      await prisma.user.findMany({
        where: { emailOptOuts: { some: { projectId } }, email: { in: subscribers.map((s) => s.email), mode: "insensitive" } },
        select: { email: true },
      })
    ).map((user) => user.email.toLowerCase()),
  );
  const people = subscribers.filter((s) => !optedOut.has(s.email));
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
    const claimedAt = await claim(entryId, id);
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
  // Done once nobody's email is left in flight: if another run is still sending one and dies, the cron finds it.
  await prisma.changelogEntry.updateMany({ where: { id: entryId, subscriberEmails: { none: { sentAt: null } } }, data: { subscribersEmailDueAt: null } });
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
