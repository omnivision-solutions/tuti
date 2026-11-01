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
/**
 * After two days, an entry's emails aren't news anymore. Two, not one: a run held at a new project's daily cap
 * just after midnight (UTC) may only be picked again a whole day on, once the cap's day is over.
 */
const RESUBMIT_FOR_HOURS = 48;
/** Well under LATE_MINUTES, so a live run's claim never looks abandoned. */
const RENEW_MS = 60_000;

const late = () => new Date(Date.now() - LATE_MINUTES * 60_000);

type Db = Pick<typeof prisma, "changelogSubscriber" | "user">;

/**
 * The addresses (of these) where someone turned all of the project's emails off ("Unsubscribe" in a shipped email,
 * say), lowercase: their account's address, or the one the project's SSO gives them (where its emails go, as
 * postAudience has it). That wins over a changelog subscription, however it was made, until they turn them back on.
 */
export async function optedOutAddresses(projectId: string, addresses: string[], db: Db = prisma): Promise<Set<string>> {
  const people = await db.user.findMany({
    where: {
      emailOptOuts: { some: { projectId } },
      OR: [{ email: { in: addresses, mode: "insensitive" } }, { ssoIdentity: { projectId, email: { in: addresses, mode: "insensitive" } } }],
    },
    select: { email: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });
  return new Set(
    people.flatMap((person) => [person.email, person.ssoIdentity?.projectId === projectId ? person.ssoIdentity.email : null].flatMap((a) => (a ? [a.toLowerCase()] : []))),
  );
}

/**
 * Who an entry goes to: the project's subscribers confirmed by the time it was published with Email subscribers
 * (`emailedAt`), past anyone who turned all of the project's emails off (optedOutAddresses). Oldest first.
 * `only`: just this one (as they are now, in a claim's transaction).
 */
async function audience(projectId: string, emailedAt: Date, only?: string, db: Db = prisma) {
  const subscribers = await db.changelogSubscriber.findMany({
    where: { projectId, confirmedAt: { not: null, lte: emailedAt }, ...(only && { id: only }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, email: true, token: true },
  });
  const optedOut = await optedOutAddresses(
    projectId,
    subscribers.map((s) => s.email),
    db,
  );
  return subscribers.filter((s) => !optedOut.has(s.email));
}

/** Of who an entry is for (audience), those with no email of it sent yet. */
async function unsent(entryId: string, projectId: string, emailedAt: Date) {
  const sent = new Set(
    (await prisma.changelogEmail.findMany({ where: { entryId, sentAt: { not: null } }, select: { subscriberId: true } })).map((e) => e.subscriberId),
  );
  return (await audience(projectId, emailedAt)).filter((s) => !sent.has(s.id));
}

/** How many people publishing an entry with Email subscribers would email now: the editor's count (as audience has it). */
export async function subscriberCount(projectId: string): Promise<number> {
  return (await audience(projectId, new Date())).length;
}

/** Whether this subscriber would be emailed an entry published now (as audience has it): their page says so. */
export async function getsChangelog(projectId: string, subscriberId: string): Promise<boolean> {
  return (await audience(projectId, new Date(), subscriberId)).length > 0;
}

/**
 * How many subscribers an entry is still to be emailed to: 0 when none are due (never asked for, or all sent), and on
 * a private portal, which emails nobody (changelogEmailed).
 */
export async function subscribersLeft(entryId: string): Promise<number> {
  const entry = await prisma.changelogEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { projectId: true, subscribersEmailedAt: true, subscribersEmailDueAt: true, project: { select: { portalAccess: true } } },
  });
  return entry.subscribersEmailedAt && entry.subscribersEmailDueAt && entry.project.portalAccess === "PUBLIC"
    ? (await unsent(entryId, entry.projectId, entry.subscribersEmailedAt)).length
    : 0;
}

/**
 * Takes on emailing one subscriber, while they still want it and the entry is still for everyone: their consent, the
 * entry's being published and its portal's being public, all read again now, with their rows locked (so
 * unsubscribing, unpublishing or making the portal private waits for this, or this sees it), not as the run began.
 * A new claim, or one a crashed run left unsent. Returns the claim's time, which the run then uses to mark it sent or
 * release it (never touching a claim another run took over); null when they don't want it any more, someone else has
 * it, or it's sent; "stop" when the entry is unpublished or its portal private now.
 */
async function claim(entry: { id: string; projectId: string; emailedAt: Date }, subscriberId: string): Promise<Date | null | "stop"> {
  return prisma.$transaction(async (tx) => {
    // The project's row first, then the entry's, as publishing takes them (lockProject, then the entry), so the two
    // can't each hold one the other waits for; the subscriber's last.
    const [project] = await tx.$queryRaw<{ portalAccess: string }[]>`
      SELECT "portalAccess" FROM "project" WHERE "id" = ${entry.projectId} FOR SHARE`;
    const [current] = await tx.$queryRaw<{ publishedAt: Date | null }[]>`
      SELECT "publishedAt" FROM "changelog_entry" WHERE "id" = ${entry.id} FOR SHARE`;
    if (!current?.publishedAt || project?.portalAccess !== "PUBLIC") {
      return "stop";
    }
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
 * releases it for a retry. Both touch only this run's claim: once another run has taken it over (renewing finds
 * it changed), it's theirs, and this run leaves it be. A renewal that fails (the database away a moment) is
 * logged and tried again next minute, never left to reject. Returns the send's error, if any.
 */
async function whileClaimed(entryId: string, subscriberId: string, claimedAt: Date, log: JobLogger, send: () => Promise<unknown>) {
  let current = claimedAt;
  let lost = false;
  let renewing = Promise.resolve();
  const renew = async () => {
    if (lost) {
      return;
    }
    try {
      const next = new Date();
      const { count } = await prisma.changelogEmail.updateMany({ where: { entryId, subscriberId, claimedAt: current }, data: { claimedAt: next } });
      if (count === 1) {
        current = next;
      } else {
        lost = true;
        log.warn(`another run took over emailing changelog entry ${entryId} to a subscriber while this one was sending`);
      }
    } catch (error) {
      log.warn(`couldn't renew the claim on emailing changelog entry ${entryId} to a subscriber: ${(error as Error).message}`);
    }
  };
  const heartbeat = setInterval(() => (renewing = renewing.then(renew)), RENEW_MS);
  let error: Error | null = null;
  try {
    await send();
  } catch (e) {
    error = e as Error;
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }
  if (lost) {
    return null;
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
  // Not those it's sent to already (a retry after a failed few), so each run only works through the rest.
  const people = await unsent(entryId, projectId, emailedAt);
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
  let stopped = false;
  for (const { id, email, token } of people) {
    // Claimed before sending, so a retry or a second run doesn't email them twice.
    const claimedAt = await claim({ id: entryId, projectId, emailedAt }, id);
    if (claimedAt === "stop") {
      stopped = true;
      break;
    }
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
    const error = await whileClaimed(entryId, id, claimedAt, log, () =>
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
  if (stopped) {
    // Still due: published again, the rest go; on a private portal, the next run lets them go.
    log.info(`changelog entry ${entryId}: emailed ${emailed}, then it was unpublished or its portal made private`);
    return { emailed, waiting: "the entry was unpublished, or its portal made private" };
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back two days) until the rest may go.
    await prisma.changelogEntry.updateMany({ where: { id: entryId, subscribersEmailDueAt: { not: null } }, data: { subscribersEmailDueAt: new Date() } });
    return { emailed, waiting: "the project's daily cap, or a pause" };
  }
  // Done once everyone it's for (as they are now) has it. Not from the claims: one another run held (and so this run
  // skipped) may be let go since, past the cap; then its subscriber has none, and would be left out for good.
  const left = (await unsent(entryId, projectId, emailedAt)).length;
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
