import { type Doc, emailImageKey, fromPlainText } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import { changelogEmail, sendEmail } from "@tuti/email";
import { type JobInput, plansEnabled } from "@tuti/shared";

import { cappedProjects, claimProjectEmail, dueAgain, heldDueDates, monthCappedProjects, nextMonth, releaseProjectEmail, tellEmailLimit, tomorrow } from "./email-limits";
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

type Db = Pick<typeof prisma, "$queryRaw">;

/**
 * Where a subscriber stands with the changelog: one rule, which the subscription and confirmation pages ask, and the
 * sender and the editor's counts read in SQL (audienceSql, its "gets" and "paused"), so no page promises what isn't sent.
 * - "gets": it's emailed to them.
 * - "paused": it will be, once the project's email is resumed (its bounces or complaints went over); the entries published meanwhile aren't.
 * - "unconfirmed": they haven't confirmed (or unsubscribed since).
 * - "private": the portal is private, which emails nobody its changelog.
 * - "opted-out": they've turned all of the project's emails off ("Unsubscribe" in a shipped email, say). That wins,
 *   however the subscription was made, until they turn them back on (a confirmation link's page).
 */
export type ChangelogReach = "gets" | "paused" | "unconfirmed" | "private" | "opted-out";

/**
 * SQL: whether someone at `email` (an address, or a column) turned all of the project's emails off. It matches their
 * account's address, or the one the project's SSO gives them (where its emails go, as postAudience has it), in any
 * case. Checked in the query that reads the subscribers, so no list of addresses is sent (a long one would pass
 * Postgres's limit on a query's parameters).
 */
const optedOutSql = (projectId: string, email: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "email_opt_out" o
  JOIN "user" u ON u."id" = o."userId"
  LEFT JOIN "sso_identity" si ON si."userId" = u."id" AND si."projectId" = o."projectId"
  WHERE o."projectId" = ${projectId} AND (lower(u."email") = lower(${email}) OR lower(si."email") = lower(${email}))
)`;

/** ChangelogReach for one subscriber's address (`confirmed`: whether they are, or as if, for a confirmation link). audienceSql is its SQL. */
export async function changelogReach(projectId: string, subscriber: { email: string; confirmed: boolean }): Promise<ChangelogReach> {
  const [{ optedOut }] = await prisma.$queryRaw<[{ optedOut: boolean }]>`SELECT ${optedOutSql(projectId, Prisma.sql`${subscriber.email}`)} AS "optedOut"`;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true, emailPausedAt: true } });
  // Paused only where projects are paused at all (projectEmailWaits).
  const paused = plansEnabled() && project.emailPausedAt !== null;
  return !subscriber.confirmed ? "unconfirmed" : project.portalAccess !== "PUBLIC" ? "private" : optedOut ? "opted-out" : paused ? "paused" : "gets";
}

/** Whether ChangelogReach means it's (or will be) emailed to them. */
export const reached = (reach: ChangelogReach) => reach === "gets" || reach === "paused";

/**
 * SQL: who an entry goes to, as `s`: the project's subscribers confirmed by the time it was published with Email
 * subscribers (`emailedAt`) that changelogReach reaches, on a public portal and not opted out (paused still counts here:
 * the job waits while the project's email is paused, and the editor's counts are 0 then). `unsentOf`: of those, the ones with no email of that
 * entry sent yet. The sender reads its rows and the editor counts them, both from this.
 */
const audienceSql = (projectId: string, emailedAt: Date, unsentOf?: string) => Prisma.sql`
  FROM "changelog_subscriber" s
  JOIN "project" p ON p."id" = s."projectId" AND p."portalAccess" = 'PUBLIC'
  WHERE s."projectId" = ${projectId} AND s."confirmedAt" IS NOT NULL AND s."confirmedAt" <= ${emailedAt}
    AND NOT ${optedOutSql(projectId, Prisma.raw(`s."email"`))}
    ${unsentOf ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "changelog_email" e WHERE e."entryId" = ${unsentOf} AND e."subscriberId" = s."id" AND e."sentAt" IS NOT NULL)` : Prisma.empty}`;

/** audienceSql's people, oldest first. `only`: just this one (as they are now, in a claim's transaction). */
async function audience(projectId: string, emailedAt: Date, { only, unsentOf }: { only?: string; unsentOf?: string } = {}, db: Db = prisma) {
  return db.$queryRaw<{ id: string; email: string; token: string }[]>`
    SELECT s."id", s."email", s."token" ${audienceSql(projectId, emailedAt, unsentOf)}
      ${only ? Prisma.sql`AND s."id" = ${only}` : Prisma.empty}
    ORDER BY s."createdAt", s."id"`;
}

/** How many audienceSql has, counted in the database (a big list's rows never leave it). */
async function audienceSize(...args: Parameters<typeof audienceSql>) {
  const [row] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS "count" ${audienceSql(...args)}`;
  return row!.count;
}

/**
 * How many people publishing an entry with Email subscribers would email now: the editor's count (audienceSql, so
 * changelogReach). Null on a private portal, which emails nobody its changelog.
 */
export async function subscriberCount(projectId: string): Promise<number | null> {
  const { portalAccess } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true } });
  // While the project's email is paused nothing is: the resume lets what it held go.
  return portalAccess !== "PUBLIC" ? null : (await projectEmailWaits(projectId)) ? 0 : audienceSize(projectId, new Date());
}

/**
 * How many subscribers an entry is still to be emailed to: 0 when none are due (never asked for, or all sent), and on
 * a private portal, which emails nobody (changelogEmailed).
 */
export async function subscribersLeft(entryId: string): Promise<number> {
  const entry = await prisma.changelogEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { projectId: true, subscribersEmailedAt: true, subscribersEmailDueAt: true },
  });
  // audienceSql (changelogReach) leaves out a private portal's: none are left there.
  return entry.subscribersEmailedAt && entry.subscribersEmailDueAt && !(await projectEmailWaits(entry.projectId))
    ? audienceSize(entry.projectId, entry.subscribersEmailedAt, entryId)
    : 0;
}

/**
 * Takes on emailing one subscriber, while they still want it and the entry is still for everyone: their consent, the
 * entry's being published and its portal's being public, all read again now, with their rows locked (so
 * unsubscribing, unpublishing or making the portal private waits for this, or this sees it), not as the run began.
 * A new claim, or one a crashed run left unsent. Returns the claim's time, which the run then uses to mark it sent or
 * release it (never touching a claim another run took over); null when they don't want it any more, someone else has
 * it, or it's sent; "stop" when the entry is unpublished, its portal private or its emails let go now.
 */
async function claim(entry: { id: string; projectId: string; emailedAt: Date }, subscriberId: string): Promise<Date | null | "stop"> {
  return prisma.$transaction(async (tx) => {
    // The project's row first, then the entry's, as publishing takes them (lockProject, then the entry), so the two
    // can't each hold one the other waits for; the subscriber's last.
    const [project] = await tx.$queryRaw<{ portalAccess: string }[]>`
      SELECT "portalAccess" FROM "project" WHERE "id" = ${entry.projectId} FOR SHARE`;
    const [current] = await tx.$queryRaw<{ publishedAt: Date | null; due: Date | null }[]>`
      SELECT "publishedAt", "subscribersEmailDueAt" AS due FROM "changelog_entry" WHERE "id" = ${entry.id} FOR SHARE`;
    // Its emails let go meanwhile (a resume drops a pause's): nobody else.
    if (!current?.publishedAt || !current.due || project?.portalAccess !== "PUBLIC") {
      return "stop";
    }
    await tx.$queryRaw`SELECT 1 FROM "changelog_subscriber" WHERE "id" = ${subscriberId} FOR UPDATE`;
    if ((await audience(entry.projectId, entry.emailedAt, { only: subscriberId }, tx)).length === 0) {
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
      sample: true,
      projectId: true,
      project: { select: { name: true, slug: true, portalAccess: true, brandColor: true } },
    },
  });
  // Not due (sent, never asked for), or sample content (Home's, for the team to try things with: never emailed).
  if (!entry?.subscribersEmailDueAt || !entry.subscribersEmailedAt || entry.sample) {
    return { skipped: true };
  }
  // Every clear is of the due time this run read, so one set since (published again) stays.
  const dueAsRead = { id: entryId, subscribersEmailDueAt: entry.subscribersEmailDueAt };
  // On a private portal (since it was published): let go, while it still is.
  if (entry.project.portalAccess === "PRIVATE") {
    await prisma.changelogEntry.updateMany({ where: { ...dueAsRead, project: { portalAccess: "PRIVATE" } }, data: { subscribersEmailDueAt: null } });
    return { skipped: true };
  }
  // Taken off the portal meanwhile: still due, so publishing it again sends the rest.
  if (!entry.publishedAt) {
    return { waiting: "the entry isn't published" };
  }
  const { projectId, project } = entry;
  // The project's email is paused: still due, till the resume drops it (apps/web/src/server/email-pause.ts).
  if (await projectEmailWaits(projectId)) {
    return { waiting: "the project's email is paused" };
  }
  const emailedAt = entry.subscribersEmailedAt;
  // Not those it's sent to already (a retry after a failed few), so each run only works through the rest.
  const people = await audience(projectId, emailedAt, { unsentOf: entryId });
  // Claims a crashed try left unsent for people no longer to be emailed (unsubscribed since) are dropped,
  // so they don't keep the entry due. A run still sending keeps its claim (not stale yet).
  // (Those claims, few, are read and matched here: no list of the whole audience goes into a query.)
  const eligible = new Set(people.map((p) => p.id));
  const stale = await prisma.changelogEmail.findMany({ where: { entryId, sentAt: null, claimedAt: { lt: late() } }, select: { subscriberId: true } });
  const dropped = stale.map((c) => c.subscriberId).filter((id) => !eligible.has(id));
  if (dropped.length > 0) {
    await prisma.changelogEmail.deleteMany({ where: { entryId, sentAt: null, claimedAt: { lt: late() }, subscriberId: { in: dropped } } });
  }

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
    // A new project's daily cap, the month's limit (and a pause since the run began): past it, they're let go and wait.
    const now = new Date();
    if (!(await claimProjectEmail(projectId, now))) {
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
          accent: project.brandColor,
        }),
        ...sender,
        // One-click unsubscribe (RFC 8058): mail apps POST to this URL.
        headers: { ...sender.headers, "List-Unsubscribe": `<${origin}/changelog/subscription/unsubscribe?${query}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    );
    if (error) {
      failed++;
      await releaseProjectEmail(projectId, now);
      log.warn(`couldn't email changelog entry ${entryId} to a subscriber: ${error.message}`);
      continue;
    }
    emailed++;
  }
  if (failed > 0) {
    // Held for a month (dueAgain), the safety nets would take it every run, for good: due from now instead, so it's retried
    // like any other failure, within their look-back.
    await prisma.changelogEntry.updateMany({ where: { id: entryId, subscribersEmailDueAt: { in: heldDueDates() } }, data: { subscribersEmailDueAt: new Date() } });
    throw new Error(`${failed} changelog email(s) for entry ${entryId} failed; retrying those`);
  }
  if (stopped) {
    // Still due: published again, the rest go; on a private portal, the next run lets them go.
    log.info(`changelog entry ${entryId}: emailed ${emailed}, then it was unpublished or its portal made private`);
    return { emailed, waiting: "the entry was unpublished, or its portal made private" };
  }
  if (held) {
    // Due from now, so the cron keeps bringing it back (it looks back two days) until the rest may go; past the month's limit, from next month.
    await prisma.changelogEntry.updateMany({ where: { id: entryId, subscribersEmailDueAt: { not: null } }, data: { subscribersEmailDueAt: await dueAgain(projectId) } });
    return { emailed, waiting: "the project's daily cap, its monthly limit, or a pause" };
  }
  // Done once everyone it's for (as they are now) has it. Not from the claims: one another run held (and so this run
  // skipped) may be let go since, past the cap; then its subscriber has none, and would be left out for good.
  const left = await audienceSize(projectId, emailedAt, entryId);
  if (left > 0) {
    log.info(`changelog entry ${entryId}: emailed ${emailed} subscriber(s), ${left} left (another run has them, or let them go)`);
    return { emailed, left };
  }
  await prisma.changelogEntry.updateMany({ where: dueAsRead, data: { subscribersEmailDueAt: null } });
  log.info(`changelog entry ${entryId}: emailed ${emailed} subscriber(s)`);
  return { emailed };
}

/** The safety net: an entry whose emails are still due after a while gets its job again. Claims keep that from emailing anyone twice. */
export async function resubmitChangelogEmails(_input: JobInput<"resubmitChangelogEmails">, log: JobLogger): Promise<JobResult> {
  // Not a paused project's: it'd wait again. The longest due first.
  // A project whose month is full: what's due now waits for next month, where these find it (a job that never ran
  // would otherwise leave it here, past the look-back, for good).
  const full = await monthCappedProjects();
  if (full.length > 0) {
    // Not a paused one's: what the pause holds, its resume lets go (or drops).
    // Nor sample content, which never has effects outside (the team's notice included).
    const moving = { projectId: { in: full }, project: { emailPausedAt: null }, sample: false, publishedAt: { not: null }, subscribersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } };
    const projects = await prisma.changelogEntry.findMany({ where: moving, distinct: ["projectId"], select: { projectId: true } });
    await prisma.changelogEntry.updateMany({ where: moving, data: { subscribersEmailDueAt: nextMonth(new Date()) } });
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
    await prisma.changelogEntry.updateMany({
      where: { projectId: { in: daily }, project: { emailPausedAt: null }, subscribersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } },
      data: { subscribersEmailDueAt: tomorrow(new Date()) },
    });
  }
  const due = await prisma.changelogEntry.findMany({
    where: {
      // Due a while ago, or held by the monthly limit (dueAgain): once its month has reset, or now where the project has room again (an upgrade).
      OR: [{ subscribersEmailDueAt: { lt: late(), gt: new Date(Date.now() - RESUBMIT_FOR_HOURS * 3_600_000) } }, { subscribersEmailDueAt: { in: heldDueDates() } }],
      // One taken off the portal waits to be published again (which queues it).
      publishedAt: { not: null },
      ...(plansEnabled() && { project: { emailPausedAt: null } }),
      // Not a capped project's (its month full, or a new one's daily cap): it'd wait again. What they hold is due when
      // the cap resets (dueAgain), within the look-back then.
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
