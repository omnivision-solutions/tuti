import { type DiffLine, diffLines, nearChanges } from "@tuti/content";
import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { autopilotEmail, type AutopilotEmailChange, type AutopilotEmailUpdate, emailConfigured, sendEmail } from "@tuti/email";
import { codeChangesEnabled, log, planIncludes } from "@tuti/shared";

import { type AutopilotButton, signAutopilotButton } from "./autopilot";

/**
 * Autopilot's email (docs/plan.md, A5): when a change's analysis is saved, each person told about it
 * gets a notice; a minute's sweep sends each person's notices from the same ten minutes in one email.
 */

/** How long notices wait for others to join them in one email. */
const MERGE_MINUTES = 10;
/** How long a sweep's claim on notices holds: one that stopped before sending them (a deploy) leaves them to the next after this. */
const CLAIM_MINUTES = 15;
/** Sends of one email to an address the mail server refuses (5xx) before it's given up, CLAIM_MINUTES apart. */
const MAX_SENDS = 5;
/** Updates shown in an email; past them, "+N more in Tuti". */
const SHOWN = 5;

/** Kinds customers see once they go out (the rest are drafts only the team sees). */
const PUBLIC = new Set<CodeChangeActionKind>(["RESOLVES", "MOVES_FORWARD", "ARTICLE_EDIT"]);

/** Applied by Autopilot itself, nobody approving it. */
const auto = (action: { payload: unknown }) => ((action.payload ?? {}) as { auto?: boolean }).auto === true;
/** When Autopilot made an update its own: when the runner marked it (`autoAt`), or before that was kept, when it was decided. */
const goneAt = (action: { payload: unknown; decidedAt: Date | null }) => {
  const autoAt = ((action.payload ?? {}) as { autoAt?: unknown }).autoAt;
  return typeof autoAt === "string" ? new Date(autoAt) : action.decidedAt;
};
/** Gone out by itself where customers see it. */
const wentOut = (action: { kind: CodeChangeActionKind; status: string; payload: unknown }) => action.status === "APPLIED" && auto(action) && PUBLIC.has(action.kind);

const appOrigin = () => (process.env.APP_URL ? new URL(process.env.APP_URL).origin : "");

/**
 * Who's told about a change: its project's owners, admins when the project says so, and the team
 * members it chose, each unless they turned Autopilot's email off. Owners are told whatever they
 * chose when something customers see goes out by itself, so the hold never passes unseen. Returns how many.
 */
export async function queueAutopilotNotices(codeChangeId: string): Promise<number> {
  // Called once the analysis is saved: a failure here is logged, not the analysis's (which would mark it failed and run it again).
  return queueNotices(codeChangeId).catch((error: unknown) => {
    log.error("Queuing Autopilot's email failed", { error, codeChangeId });
    return 0;
  });
}

async function queueNotices(codeChangeId: string): Promise<number> {
  const change = await prisma.codeChange.findUnique({
    where: { id: codeChangeId },
    select: {
      projectId: true,
      project: { select: { autopilotTellAdmins: true } },
      actions: { where: { status: { in: ["PENDING", "STALE", "SCHEDULED", "APPLIED"] } }, select: { kind: true, status: true, payload: true, decidedAt: true } },
    },
  });
  // What customers see that went out by itself just now (no hold: the runner may apply it before this runs) is this analysis's.
  const justNow = new Date(Date.now() - MERGE_MINUTES * 60_000);
  const gone = change?.actions.filter((action) => wentOut(action) && (goneAt(action)?.getTime() ?? 0) > justNow.getTime()) ?? [];
  // Nothing to do or tell, nothing to say.
  if (!change || (!change.actions.some((action) => action.status !== "APPLIED") && gone.length === 0)) {
    return 0;
  }
  const goesOutUnseen = gone.length > 0 || change.actions.some((action) => action.status === "SCHEDULED" && PUBLIC.has(action.kind));
  const team = await prisma.teamMember.findMany({
    where: { projectId: change.projectId },
    select: { role: true, autopilotTold: true, userId: true, user: { select: { autopilotEmails: true } } },
  });
  const told = team.filter((member) => isTold(member, change.project, goesOutUnseen));
  const userIds = told.map(({ userId }) => userId);
  // In this order, so whatever a sweep does with someone's notice meanwhile (sends it, puts it back, drops it),
  // a later step catches it. Being sent right now (with what the analysis before found): left unsent by that
  // sweep, so it goes again.
  await prisma.$executeRaw`
    UPDATE autopilot_notice SET "newsFrom" = COALESCE("newsFrom", "createdAt" - make_interval(mins => ${MERGE_MINUTES})), "createdAt" = now() AT TIME ZONE 'UTC', attempts = 0
    WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${userIds}) AND "sentAt" IS NULL AND "claimedAt" IS NOT NULL`;
  // Told already (an analysis before this one): told again, about what this one found; what Autopilot did by
  // itself before that email isn't news again (`since`).
  const again = await prisma.$executeRaw`
    UPDATE autopilot_notice SET "since" = "sentAt", "newsFrom" = NULL, "sentAt" = NULL, "claimedAt" = NULL, "createdAt" = now() AT TIME ZONE 'UTC', attempts = 0
    WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${userIds}) AND "sentAt" IS NOT NULL`;
  // Not told yet (or the sweep dropped it): told now.
  const { count } = await prisma.autopilotNotice.createMany({
    data: userIds.map((userId) => ({ codeChangeId, userId })),
    skipDuplicates: true,
  });
  return count + again;
}

/** Whether someone on the team is told: owners (always, while something customers see goes out by itself), admins the project tells, members it picked; each unless they turned it off. */
function isTold(
  member: { role: string; autopilotTold: boolean; user: { autopilotEmails: string } },
  project: { autopilotTellAdmins: boolean },
  goesOutUnseen: boolean,
): boolean {
  const on = member.user.autopilotEmails === "AS_THEY_HAPPEN";
  if (member.role === "OWNER") {
    return on || goesOutUnseen;
  }
  return on && (member.autopilotTold || (member.role === "ADMIN" && project.autopilotTellAdmins));
}

const statusName = (status: string) => status.charAt(0) + status.slice(1).toLowerCase().replace("_", " ");

/** "in 24 hours", "now": when an update goes out, without the reader's time zone. */
const when = (dueAt: Date | null, now: Date) => {
  const hours = dueAt ? Math.round((dueAt.getTime() - now.getTime()) / 3_600_000) : 0;
  return hours < 1 ? "now" : hours === 1 ? "in an hour" : `in ${hours} hours`;
};

type ActionRow = {
  id: string;
  kind: CodeChangeActionKind;
  status: string;
  dueAt: Date | null;
  decidedAt: Date | null;
  payload: unknown;
  post: { title: string; status: string } | null;
  article: { title: string } | null;
};

/** Lines of an edit an email shows (changed ones, with one unchanged either side); the rest are on its page. */
const DIFF_LINES = 8;
/** How much of an unchanged line shows, for context. Changed ones show whole: they're what Approve publishes. */
const CONTEXT_LENGTH = 280;
const clip = (text: string) => (text.length > CONTEXT_LENGTH ? `${text.slice(0, CONTEXT_LENGTH - 1)}…` : text);
/** A progress update with nothing to post: it can't be approved as it is (applying it asks for the comment). */
const uncommented = (action: { kind: CodeChangeActionKind; payload: unknown }) =>
  action.kind === "MOVES_FORWARD" && !((action.payload ?? {}) as { comment?: string }).comment?.trim();

/** One update as the email previews it: what it is, about what, and what it changes (line by line). */
function previewOf(action: ActionRow, now: Date): AutopilotEmailUpdate {
  const payload = (action.payload ?? {}) as { comment?: string; line?: string; title?: string; problem?: string; before?: string; body?: string };
  const label: Record<CodeChangeActionKind, string> = {
    RESOLVES: "Closes the request",
    MOVES_FORWARD: "Progress update",
    LINKS: "Link",
    ARTICLE_EDIT: payload.problem === "missing" ? "Missing info" : "Out of date",
    NEW_ARTICLE: "New article",
    CHANGELOG_LINE: "Changelog line",
  };
  // Gone already (by itself, before this email): what it did, not what it will do.
  const done = action.status === "APPLIED";
  const fact: Record<CodeChangeActionKind, string> = {
    RESOLVES: done ? "Completed, emailing the people who asked" : `${statusName(action.post?.status ?? "OPEN")} → Completed, emailing the people who asked`,
    MOVES_FORWARD: done ? "In progress, with this comment" : uncommented(action) ? "Marks it in progress: write its comment first" : "Marks it in progress, with this comment",
    LINKS: done ? "Linked the pull request" : "Links the pull request",
    ARTICLE_EDIT: done ? "Published this edit" : "Publishes this edit",
    NEW_ARTICLE: "A draft only your team sees",
    CHANGELOG_LINE: done ? "Wrote this line in the changelog's draft" : "Writes this line in the changelog's draft",
  };
  const added = (text = "") => (text.trim() ? [{ kind: "added" as const, text }] : undefined);
  const edit = action.kind === "ARTICLE_EDIT" ? nearChanges(diffLines(payload.before ?? "", payload.body ?? ""), 1) : [];
  // Cut after DIFF_LINES, but not between a paragraph's removed line and what replaces it (up to twice as many).
  let cut = Math.min(DIFF_LINES, edit.length);
  while (cut < Math.min(edit.length, 2 * DIFF_LINES) && edit[cut]!.kind !== "same" && edit[cut - 1]!.kind !== "same") {
    cut++;
  }
  const diff: Partial<Record<CodeChangeActionKind, DiffLine[]>> = {
    MOVES_FORWARD: added(payload.comment),
    ARTICLE_EDIT: edit.slice(0, cut).map((line) => (line.kind === "same" ? { ...line, text: clip(line.text) } : line)),
    CHANGELOG_LINE: added(payload.line),
  };
  return {
    kind: label[action.kind],
    title: action.post?.title ?? action.article?.title ?? payload.title ?? "Changelog",
    fact: fact[action.kind],
    ...(diff[action.kind] && { diff: diff[action.kind] }),
    ...(edit.length > cut && { diffMore: edit.length - cut }),
    ...(action.status === "SCHEDULED" && { goesOut: when(action.dueAt, now) }),
  };
}

type EmailedChange = { id: string; title: string; repo: string; number: number; summary: string; actions: (ActionRow & { waitReason?: string | null })[] };

/**
 * An email's five updates: room for what needs the team first (`needsYou` of them, across all its changes), but
 * one kept for what goes out by itself when anything does (`goesOut`), so its Stop is always there; what's left
 * for the rest. `take` cuts a list (`needsYou`: one of those) to the room left; `more` counts what didn't fit.
 */
function shownFive(needsYou: number, goesOut: number) {
  const first = Math.min(needsYou, SHOWN - (goesOut > 0 ? 1 : 0));
  const room = { needsYou: first, rest: SHOWN - first };
  let more = 0;
  return {
    take: (list: AutopilotEmailUpdate[], isNeedsYou = false) => {
      const which = isNeedsYou ? "needsYou" : "rest";
      const shown = list.slice(0, room[which]);
      room[which] -= shown.length;
      more += list.length - shown.length;
      return shown;
    },
    more: () => more,
  };
}

/**
 * One change as an email shows it to `userId`: what goes out by itself (Publish now, Stop), what needs them
 * (Approve, Edit), and what Autopilot did by itself already (`gone`: what customers see; `drafts`: what only
 * the team sees), each list cut by `take` (the email's five).
 */
function emailChange(
  codeChange: EmailedChange,
  projectSlug: string,
  userId: string,
  now: Date,
  take: (list: AutopilotEmailUpdate[], needsYou?: boolean) => AutopilotEmailUpdate[],
  gone: ActionRow[],
  drafts: ActionRow[],
): AutopilotEmailChange {
  const page = `${appOrigin()}/app/${projectSlug}/autopilot/${codeChange.id}`;
  // One click for this person, signed in (see the act page); anyone else only gets the page.
  const act = (button: AutopilotButton) => {
    const token = signAutopilotButton(userId, codeChange.id, button, now);
    return token ? `${page}/act?token=${token}` : `${page}?select=likely`;
  };
  const scheduled = codeChange.actions.filter((action) => action.status === "SCHEDULED");
  const goesOut = take(scheduled.map((action) => previewOf(action, now)));
  // Publish now and Stop are for the ones it shows: not those past its five, nor others analysed again in their place.
  const shown = scheduled.slice(0, goesOut.length).map((action) => action.id).join(",");
  const needsYou = codeChange.actions
    .filter((action) => action.status === "PENDING" || action.status === "STALE")
    .map((action) => ({
      ...previewOf(action, now),
      // Out of date ones and progress updates with nothing to post can't be approved as they are, and one a teammate
      // stopped isn't to approve unasked: Edit only.
      ...(action.status === "PENDING" && !action.waitReason?.startsWith("Stopped by") && !uncommented(action) && { approveUrl: act(`approve:${action.id}`) }),
      editUrl: `${page}?select=${action.id}`,
    }));
  return {
    title: codeChange.title,
    pullRequest: `${codeChange.repo}#${codeChange.number}`,
    summary: codeChange.summary,
    reviewUrl: `${page}?select=likely`,
    ...(shown && { publishUrl: act(`publish:${shown}`), stopUrl: act(`stop:${shown}`) }),
    goesOut,
    wentOut: take(gone.map((action) => previewOf(action, now))),
    needsYou: take(needsYou, true),
    done: take(drafts.map((action) => previewOf(action, now))),
  };
}

/**
 * Whether a failed send was the mail server refusing this address (5xx to its RCPT TO): that's the address's.
 * Anything else (down, a failed login, the sender or the message refused, its limits) is the server's, and passes.
 */
function refusedAddress(error: unknown): boolean {
  const { responseCode: code, command } = error as { responseCode?: unknown; command?: unknown };
  return typeof code === "number" && code >= 500 && typeof command === "string" && /^RCPT\b/i.test(command);
}

/**
 * The minute's sweep: each person's notices from ten minutes ago or more (with any newer ones of the
 * same project, so nothing's left for a lonely email right after) go in one email, then are marked
 * sent. Claimed first, so two sweeps send each once; a failed send is tried again next minute.
 * Returns how many emails went.
 */
export async function sendAutopilotEmails(now = new Date()): Promise<number> {
  // Without a mail server nothing would go: they wait (unsent) rather than being marked sent.
  if (!codeChangesEnabled() || !emailConfigured()) {
    return 0;
  }
  // Not sent, and not being sent (or taken by a sweep that stopped before it could send them: a deploy).
  const free = { sentAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_MINUTES * 60_000) } }] };
  const ripe = await prisma.autopilotNotice.findMany({
    where: { ...free, createdAt: { lte: new Date(now.getTime() - MERGE_MINUTES * 60_000) } },
    distinct: ["userId"],
    // Those tried least first: someone whose email keeps failing doesn't keep the others back.
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    select: { userId: true },
    take: 100,
  });
  let sent = 0;
  for (const { userId } of ripe) {
    // The sweep's own time (as its claims are judged by it), never before now.
    const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
    // One person's failing (a database error) leaves the others to go, and theirs to the next sweep.
    try {
      // Claimed first, then read as claimed: an analysis saved from here on refreshes them (queueNotices), and
      // what this sweep does with them holds only while they're as it read them. So two sweeps send each once.
      await prisma.autopilotNotice.updateMany({ where: { userId, ...free }, data: { claimedAt } });
      const notices = await prisma.autopilotNotice.findMany({
        where: { userId, claimedAt, sentAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          since: true,
          newsFrom: true,
          createdAt: true,
          attempts: true,
          user: { select: { email: true, autopilotEmails: true } },
          codeChange: {
            select: {
              id: true,
              title: true,
              repo: true,
              number: true,
              summary: true,
              project: { select: { id: true, slug: true, name: true, autopilotTellAdmins: true } },
              actions: {
                where: { status: { in: ["PENDING", "STALE", "SCHEDULED", "APPLIED"] } },
                orderBy: [{ probability: "desc" }, { id: "asc" }],
                select: {
                  id: true,
                  kind: true,
                  status: true,
                  dueAt: true,
                  decidedAt: true,
                  waitReason: true,
                  payload: true,
                  post: { select: { title: true, status: true } },
                  article: { select: { title: true } },
                },
              },
            },
          },
        },
      });
      // When what it says was read (after the claim): what the runner had in hand then showed as neither going out nor gone (tellOwners).
      const readAt = new Date();
      // One email per project: the first notice's, the rest of that project's with it; the others wait for the next sweep.
      const projectId = notices[0]?.codeChange.project.id;
      const mine = notices.filter((notice) => notice.codeChange.project.id === projectId);
      const ids = mine.map((notice) => notice.id);
      await prisma.autopilotNotice.updateMany({ where: { userId, claimedAt, id: { notIn: ids } }, data: { claimedAt: null } });
      if (mine.length === 0) {
        continue;
      }
      // Not sent after all: one sent before goes back to that (the page says they were emailed then), one never sent
      // goes; one analysed again meanwhile stays, for the next email.
      // `which`: those not sent after all (all of them, unless some of a failed send are given up and others not).
      const settle = async (which = mine) => {
        for (const notice of which) {
          const unchanged = { id: notice.id, claimedAt, createdAt: notice.createdAt };
          if (notice.since) {
            await prisma.autopilotNotice.updateMany({ where: unchanged, data: { sentAt: notice.since, since: null, claimedAt: null } });
          } else {
            await prisma.autopilotNotice.deleteMany({ where: unchanged });
          }
        }
        await prisma.autopilotNotice.updateMany({ where: { id: { in: which.map((notice) => notice.id) }, claimedAt, sentAt: null }, data: { claimedAt: null } });
      };
      const project = mine[0]!.codeChange.project;
      // Still told? (They may have left the team, or turned it off, since.) If not: dropped, not sent.
      const member = await prisma.teamMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId } },
        select: { role: true, autopilotTold: true, user: { select: { autopilotEmails: true } } },
      });
      // What Autopilot did by itself for this analysis: since a little before it was queued (as queuing reads it),
      // and since the email before this one about the change (if any). What went out between them isn't news.
      const lately = (notice: (typeof mine)[number]) => {
        // Kept apart from `createdAt` (refreshed while it waits): what went out meanwhile, never emailed, stays news.
        const queued = notice.newsFrom?.getTime() ?? notice.createdAt.getTime() - MERGE_MINUTES * 60_000;
        const from = Math.max(queued, notice.since?.getTime() ?? 0);
        return (action: ActionRow) => {
          // When it became Autopilot's own (it may have been applied, not yet marked, as an email read it).
          const at = goneAt(action);
          return auto(action) && at !== null && at.getTime() > from;
        };
      };
      const went = (notice: (typeof mine)[number]) => notice.codeChange.actions.filter((action) => wentOut(action) && lately(notice)(action));
      // Going out by itself, or gone already (a short hold passes before the email goes): owners hear of it.
      const goesOutUnseen = mine.some((notice) => went(notice).length > 0 || notice.codeChange.actions.some((action) => action.status === "SCHEDULED" && PUBLIC.has(action.kind)));
      if (!member || !isTold(member, project, goesOutUnseen)) {
        // Not told after all (left the team, turned it off): not sent.
        await settle();
        continue;
      }
      // The subject counts them all, not just the ones shown.
      const all = mine.flatMap(({ codeChange }) => codeChange.actions);
      // Drafts Autopilot wrote by itself lately (only the team sees them).
      const done = (notice: (typeof mine)[number]) => notice.codeChange.actions.filter((action) => action.status === "APPLIED" && lately(notice)(action) && !PUBLIC.has(action.kind));
      const totals = {
        goesOut: all.filter((action) => action.status === "SCHEDULED").length,
        wentOut: mine.reduce((sum, notice) => sum + went(notice).length, 0),
        needsYou: all.filter((action) => action.status === "PENDING" || action.status === "STALE").length,
        done: mine.reduce((sum, notice) => sum + done(notice).length, 0),
        first: when(
          all.filter((action) => action.status === "SCHEDULED").reduce<Date | null>((min, action) => (!min || (action.dueAt && action.dueAt < min) ? action.dueAt : min), null),
          now,
        ),
      };
      // Everything decided in the ten minutes before it went (the team approved it all, say): nothing to say.
      if (totals.goesOut + totals.wentOut + totals.needsYou + totals.done === 0) {
        await settle();
        continue;
      }
      const five = shownFive(totals.needsYou, totals.goesOut);
      const changes: AutopilotEmailChange[] = mine.map((notice) => emailChange(notice.codeChange, project.slug, userId, now, five.take, went(notice), done(notice)));
      try {
        await sendEmail({
          to: mine[0]!.user.email,
          ...autopilotEmail({ projectName: project.name, changes, totals, more: five.more(), autopilotUrl: `${appOrigin()}/app/${project.slug}/autopilot`, accountUrl: `${appOrigin()}/app/account` }),
        });
      } catch (error) {
        // Not sent: tried again once its claim lapses (CLAIM_MINUTES on); the others still go. The mail server
        // down, or not taking it for now (4xx): for as long as that lasts. It refusing this address (5xx): a few
        // times, then given up.
        const refused = refusedAddress(error);
        log.error("Sending Autopilot's email failed", { error, userId, refused });
        if (refused) {
          await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, claimedAt }, data: { attempts: { increment: 1 } } });
          // Each given up on its own count: one queued lately with one tried four times has tries left.
          const spent = mine.filter((notice) => notice.attempts + 1 >= MAX_SENDS);
          if (spent.length > 0) {
            await settle(spent);
          }
        }
        continue;
      }
      // Sent, unless analysed again while it went: that one's left unsent, for the next email. As of when its
      // content was read (its claim): what Autopilot did since is in neither this email nor, otherwise, the next.
      const sentAt = claimedAt;
      for (const notice of mine) {
        await prisma.autopilotNotice.updateMany({ where: { id: notice.id, claimedAt, createdAt: notice.createdAt }, data: { sentAt, readAt } });
      }
      // Analysed again while it went: it did go, so what it said isn't news again (and, not sent after all next
      // time, it goes back to this send).
      await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, claimedAt, sentAt: null }, data: { since: sentAt, newsFrom: sentAt, claimedAt: null } });
      sent++;
    } catch (error) {
      log.error("Autopilot's email sweep failed for someone", { error, userId });
      await prisma.autopilotNotice.updateMany({ where: { userId, claimedAt, sentAt: null }, data: { claimedAt: null } }).catch(() => undefined);
    }
  }
  return sent;
}

/** Who has been emailed about a change (its review page's "Emailed to"): sent, or sent before and queued again since (analysed again). */
export async function emailedAbout(codeChangeId: string): Promise<string[]> {
  const notices = await prisma.autopilotNotice.findMany({
    where: { codeChangeId, OR: [{ sentAt: { not: null } }, { since: { not: null } }] },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { name: true } } },
  });
  return notices.map((notice) => notice.user.name);
}

/**
 * Something customers see went out by itself (the runner applied it): the project's owners hear of it.
 * The runner may apply it as the analysis's notices are queued (no hold), before they could tell it went,
 * so each owner who hasn't heard of it is told: one with no notice for the change, one whose last email
 * about it was read before these updates existed (`since`: the earliest's creation), and one whose last
 * email was read while the runner had them in hand (`inFlight`: from taking them till their mark was saved),
 * when they showed as neither going out nor gone.
 * One being sent right now goes again. An owner emailed in between heard of them (going out, or waiting).
 */
export async function tellOwners(codeChangeId: string, since: Date, inFlight?: { from: Date; to: Date }): Promise<number> {
  try {
    const change = await prisma.codeChange.findUnique({ where: { id: codeChangeId }, select: { projectId: true } });
    if (!change) {
      return 0;
    }
    const owners = (await prisma.teamMember.findMany({ where: { projectId: change.projectId, role: "OWNER" }, select: { userId: true } })).map(({ userId }) => userId);
    // In queueNotices' order, so whatever a sweep does with a notice meanwhile, a later step catches it. One being
    // sent is let go too: its read may have missed these, so its send can't count it as told (its news stays as it was).
    await prisma.$executeRaw`
      UPDATE autopilot_notice SET "newsFrom" = COALESCE("newsFrom", "createdAt" - make_interval(mins => ${MERGE_MINUTES})), "createdAt" = now() AT TIME ZONE 'UTC', attempts = 0, "claimedAt" = NULL
      WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${owners}) AND "sentAt" IS NULL AND "claimedAt" IS NOT NULL`;
    // Its read ran from its claim (`sentAt`) to `readAt`; one that overlapped the runner's hold counts back from the
    // hold's start, so what it applied is news to the next email.
    const again = await prisma.$executeRaw`
      UPDATE autopilot_notice SET "since" = LEAST("sentAt", ${inFlight?.from ?? null}), "newsFrom" = NULL, "sentAt" = NULL, "claimedAt" = NULL, "createdAt" = now() AT TIME ZONE 'UTC', attempts = 0
      WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${owners})
        AND ("sentAt" < ${since} OR ("readAt" >= ${inFlight?.from ?? null} AND "sentAt" < ${inFlight?.to ?? null}))`;
    const { count } = await prisma.autopilotNotice.createMany({ data: owners.map((userId) => ({ codeChangeId, userId })), skipDuplicates: true });
    return count + again;
  } catch (error) {
    log.error("Telling owners what Autopilot applied failed", { error, codeChangeId });
    return 0;
  }
}

/** The morning: the digest goes from 8 o'clock, the reader's time, till noon (a sweep or a mail server late by
 * then sends it the next morning; one chosen in the afternoon comes the next morning, not straight away). */
const DIGEST_HOUR = 8;
const DIGEST_UNTIL = 12;

/** The date ("2026-10-31") and hour it is in `timeZone`; null for a zone this server doesn't know. */
function localNow(now: Date, timeZone: string): { day: string; hour: number } | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    return null;
  }
}

/**
 * The daily digest (A6): for each person who chose it, from their morning on (in the time zone their
 * browser reported), one email per project they're told about with what still waits for approval, newest
 * first; none on a day with nothing. Each project's for each of their days is claimed and sent on its own
 * (`autopilot_digest`): two sweeps send it once, and one that failed is tried again (CLAIM_MINUTES on, MAX_SENDS
 * at most) without the others going twice. Returns how many went.
 */
export async function sendAutopilotDigests(now = new Date()): Promise<number> {
  if (!codeChangesEnabled() || !emailConfigured()) {
    return 0;
  }
  // A week's claims are plenty to keep (a reader's day, wherever they are, is over by then).
  await prisma.autopilotDigest.deleteMany({ where: { day: { lt: new Date(now.getTime() - 7 * 86_400_000) } } });
  const readers = await prisma.user.findMany({ where: { autopilotEmails: "DIGEST", autopilotTimeZone: { not: null } }, select: { id: true, email: true, autopilotTimeZone: true } });
  if (readers.length === 0) {
    return 0;
  }
  // Read once a sweep, not per reader: their teams, and the digests of their last days already settled (sent, or
  // given up), which need no claim again.
  const ids = readers.map((reader) => reader.id);
  const teams = new Map<string, Awaited<ReturnType<typeof readTeams>>>();
  const readTeams = () =>
    prisma.teamMember.findMany({
      where: { userId: { in: ids } },
      select: {
        userId: true,
        role: true,
        autopilotTold: true,
        project: { select: { id: true, slug: true, name: true, autopilotTellAdmins: true, analyseCodeChanges: true, plan: true } },
      },
    });
  for (const team of await readTeams()) {
    teams.set(team.userId, [...(teams.get(team.userId) ?? []), team]);
  }
  const settled = new Set(
    (
      await prisma.autopilotDigest.findMany({
        where: { userId: { in: ids }, day: { gte: new Date(now.getTime() - 2 * 86_400_000) }, OR: [{ sentAt: { not: null } }, { attempts: { gte: MAX_SENDS } }] },
        select: { userId: true, projectId: true, day: true },
      })
    ).map((digest) => `${digest.userId} ${digest.projectId} ${digest.day.toISOString()}`),
  );
  let sent = 0;
  for (const reader of readers) {
    const local = localNow(now, reader.autopilotTimeZone!);
    // Its morning only (a sweep that ran late sends it late, not never); once a day, by the claim below.
    if (!local || local.hour < DIGEST_HOUR || local.hour >= DIGEST_UNTIL) {
      continue;
    }
    const day = new Date(`${local.day}T00:00:00Z`);
    try {
      const memberships = (teams.get(reader.id) ?? []).filter((team) => !settled.has(`${reader.id} ${team.project.id} ${day.toISOString()}`));
      for (const { role, autopilotTold, project } of memberships) {
        if (role !== "OWNER" && !autopilotTold && !(role === "ADMIN" && project.autopilotTellAdmins)) {
          continue;
        }
        // Autopilot off there (or not on its plan): what's left waiting isn't news every morning.
        if (!project.analyseCodeChanges || !planIncludes(project.plan, "codeChanges")) {
          continue;
        }
        // Taken: new for the day, or one that failed (or whose sweep stopped) a while ago, with tries left. As of
        // now, not when the sweep started: a long sweep's claim isn't one another can take as lapsed.
        const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
        const lapsed = new Date(claimedAt.getTime() - CLAIM_MINUTES * 60_000);
        const mine = { userId: reader.id, projectId: project.id, day };
        const { count: fresh } = await prisma.autopilotDigest.createMany({ data: [{ ...mine, claimedAt }], skipDuplicates: true });
        const taken =
          fresh > 0 ||
          (await prisma.autopilotDigest.updateMany({ where: { ...mine, sentAt: null, attempts: { lt: MAX_SENDS }, claimedAt: { lt: lapsed } }, data: { claimedAt } })).count > 0;
        if (!taken) {
          continue;
        }
        const waiting = await prisma.codeChange.findMany({
          where: { projectId: project.id, state: "READY", actions: { some: { status: { in: ["PENDING", "STALE"] } } } },
          orderBy: { mergedAt: "desc" },
          select: {
            id: true,
            title: true,
            repo: true,
            number: true,
            summary: true,
            actions: {
              where: { status: { in: ["PENDING", "STALE"] } },
              orderBy: [{ probability: "desc" }, { id: "asc" }],
              select: {
                id: true,
                kind: true,
                status: true,
                dueAt: true,
                decidedAt: true,
                waitReason: true,
                payload: true,
                post: { select: { title: true, status: true } },
                article: { select: { title: true } },
              },
            },
          },
        });
        // Nothing waiting: nothing to say, and the day's done.
        if (waiting.length === 0) {
          await prisma.autopilotDigest.updateMany({ where: { ...mine, claimedAt }, data: { sentAt: claimedAt } });
          continue;
        }
        const needsYou = waiting.reduce((sum, change) => sum + change.actions.length, 0);
        // The newest first, five updates in all: changes past them only counted ("+N more in Tuti").
        const five = shownFive(needsYou, 0);
        const changes = waiting.map((change) => emailChange(change, project.slug, reader.id, now, five.take, [], [])).filter((change) => change.needsYou.length > 0);
        try {
          await sendEmail({
            to: reader.email,
            ...autopilotEmail({
              projectName: project.name,
              changes,
              totals: { goesOut: 0, wentOut: 0, needsYou, first: "", pullRequests: waiting.length },
              more: five.more(),
              digest: true,
              autopilotUrl: `${appOrigin()}/app/${project.slug}/autopilot`,
              accountUrl: `${appOrigin()}/app/account`,
            }),
          });
        } catch (error) {
          // Tried again once the claim lapses: while the server's down, for as long as that lasts; the address
          // refused, a few times at most (tomorrow's comes all the same).
          const refused = refusedAddress(error);
          log.error("Sending Autopilot's digest failed", { error, userId: reader.id, projectId: project.id, refused });
          if (refused) {
            await prisma.autopilotDigest.updateMany({ where: { ...mine, claimedAt }, data: { attempts: { increment: 1 } } });
          }
          continue;
        }
        await prisma.autopilotDigest.updateMany({ where: { ...mine, claimedAt }, data: { sentAt: claimedAt } });
        sent++;
      }
    } catch (error) {
      // Its claims lapse, so what didn't go is tried again; the others' digests still go.
      log.error("Autopilot's digest sweep failed for someone", { error, userId: reader.id });
    }
  }
  return sent;
}
