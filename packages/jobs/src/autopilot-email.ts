import { type CodeChangeActionKind, prisma } from "@tuti/db";
import { autopilotEmail, type AutopilotEmailChange, type AutopilotEmailUpdate, emailConfigured, sendEmail } from "@tuti/email";
import { codeChangesEnabled, log } from "@tuti/shared";

/**
 * Autopilot's email (docs/plan.md, A5): when a change's analysis is saved, each person told about it
 * gets a notice; a minute's sweep sends each person's notices from the same ten minutes in one email.
 */

/** How long notices wait for others to join them in one email. */
const MERGE_MINUTES = 10;
/** How long a sweep's claim on notices holds: one that stopped before sending them (a deploy) leaves them to the next after this. */
const CLAIM_MINUTES = 15;
/** Updates shown in an email; past them, "+N more in Tuti". */
const SHOWN = 5;

/** Kinds customers see once they go out (the rest are drafts only the team sees). */
const PUBLIC = new Set<CodeChangeActionKind>(["RESOLVES", "MOVES_FORWARD", "ARTICLE_EDIT"]);

/** Applied by Autopilot itself, nobody approving it. */
const auto = (action: { payload: unknown }) => ((action.payload ?? {}) as { auto?: boolean }).auto === true;
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
  const gone = change?.actions.filter((action) => wentOut(action) && action.decidedAt && action.decidedAt > justNow) ?? [];
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
  const { count } = await prisma.autopilotNotice.createMany({
    data: told.map(({ userId }) => ({ codeChangeId, userId })),
    skipDuplicates: true,
  });
  // Told already (an analysis before this one): told again, about what this one found; what Autopilot did by
  // itself before that email isn't news again (`since`).
  const again = await prisma.$executeRaw`
    UPDATE autopilot_notice SET "since" = "sentAt", "sentAt" = NULL, "claimedAt" = NULL, "createdAt" = now()
    WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${told.map(({ userId }) => userId)}) AND "sentAt" IS NOT NULL`;
  // Being sent right now (with what the analysis before found): left unsent by that sweep, so it goes again.
  await prisma.$executeRaw`
    UPDATE autopilot_notice SET "createdAt" = now()
    WHERE "codeChangeId" = ${codeChangeId} AND "userId" = ANY(${told.map(({ userId }) => userId)}) AND "sentAt" IS NULL AND "claimedAt" IS NOT NULL`;
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

/** One update as the email previews it: what it is, about what, and what it changes. */
function previewOf(action: ActionRow, now: Date): AutopilotEmailUpdate {
  const payload = (action.payload ?? {}) as { comment?: string; line?: string; title?: string; problem?: string };
  const label: Record<CodeChangeActionKind, string> = {
    RESOLVES: "Closes the request",
    MOVES_FORWARD: "Progress update",
    LINKS: "Link",
    ARTICLE_EDIT: payload.problem === "missing" ? "Missing info" : "Out of date",
    NEW_ARTICLE: "New article",
    CHANGELOG_LINE: "Changelog line",
  };
  const fact: Record<CodeChangeActionKind, string> = {
    RESOLVES: `${statusName(action.post?.status ?? "OPEN")} → Completed, emailing the people who asked`,
    MOVES_FORWARD: `In progress, posting: “${payload.comment ?? ""}”`,
    LINKS: "Links the pull request",
    ARTICLE_EDIT: "Publishes its edit",
    NEW_ARTICLE: "A draft only your team sees",
    CHANGELOG_LINE: `“${payload.line ?? ""}”, in the changelog's draft`,
  };
  return {
    kind: label[action.kind],
    title: action.post?.title ?? action.article?.title ?? payload.title ?? "Changelog",
    fact: fact[action.kind],
    ...(action.status === "SCHEDULED" && { goesOut: when(action.dueAt, now) }),
  };
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
    select: { userId: true },
    take: 100,
  });
  let sent = 0;
  for (const { userId } of ripe) {
    const notices = await prisma.autopilotNotice.findMany({
      where: { userId, ...free },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        since: true,
        createdAt: true,
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
              select: { id: true, kind: true, status: true, dueAt: true, decidedAt: true, payload: true, post: { select: { title: true, status: true } }, article: { select: { title: true } } },
            },
          },
        },
      },
    });
    // One email per project: the first notice's, the rest of that project's with it.
    const projectId = notices[0]?.codeChange.project.id;
    const mine = notices.filter((notice) => notice.codeChange.project.id === projectId);
    if (mine.length === 0) {
      continue;
    }
    const ids = mine.map((notice) => notice.id);
    // Claimed first, so two sweeps send each once; marked sent only once it's gone.
    const claimedAt = new Date();
    const { count } = await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, ...free }, data: { claimedAt } });
    if (count !== ids.length) {
      // Another sweep has some of them: it sends them.
      await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, claimedAt }, data: { claimedAt: null } });
      continue;
    }
    const project = mine[0]!.codeChange.project;
    // Still told? (They may have left the team, or turned it off, since.) If not: dropped, not sent.
    const member = await prisma.teamMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
      select: { role: true, autopilotTold: true, user: { select: { autopilotEmails: true } } },
    });
    // What Autopilot did by itself since the email before this one about the change (if any): the news.
    // A first notice: what this analysis did, since a little before it was queued (as queuing reads it).
    const lately = (notice: (typeof mine)[number]) => (action: ActionRow) =>
      auto(action) && action.decidedAt !== null && action.decidedAt > (notice.since ?? new Date(notice.createdAt.getTime() - MERGE_MINUTES * 60_000));
    const went = (notice: (typeof mine)[number]) => notice.codeChange.actions.filter((action) => wentOut(action) && lately(notice)(action));
    // Going out by itself, or gone already (a short hold passes before the email goes): owners hear of it.
    const goesOutUnseen = mine.some((notice) => went(notice).length > 0 || notice.codeChange.actions.some((action) => action.status === "SCHEDULED" && PUBLIC.has(action.kind)));
    if (!member || !isTold(member, project, goesOutUnseen)) {
      // Not told after all: gone, so the page doesn't say they were emailed.
      await prisma.autopilotNotice.deleteMany({ where: { id: { in: ids } } });
      continue;
    }
    let budget = SHOWN;
    let more = 0;
    const take = (list: AutopilotEmailUpdate[]) => {
      const shown = list.slice(0, Math.max(budget, 0));
      budget -= shown.length;
      more += list.length - shown.length;
      return shown;
    };
    // The subject counts them all, not just the ones shown.
    const all = mine.flatMap(({ codeChange }) => codeChange.actions);
    const totals = {
      goesOut: all.filter((action) => action.status === "SCHEDULED").length,
      wentOut: mine.reduce((sum, notice) => sum + went(notice).length, 0),
      needsYou: all.filter((action) => action.status === "PENDING" || action.status === "STALE").length,
      first: when(
        all.filter((action) => action.status === "SCHEDULED").reduce<Date | null>((min, action) => (!min || (action.dueAt && action.dueAt < min) ? action.dueAt : min), null),
        now,
      ),
    };
    // Everything decided in the ten minutes before it went (the team approved it all, say): nothing to say.
    const done = (notice: (typeof mine)[number]) => notice.codeChange.actions.filter((action) => action.status === "APPLIED" && lately(notice)(action) && !PUBLIC.has(action.kind));
    if (totals.goesOut + totals.wentOut + totals.needsYou + mine.reduce((sum, notice) => sum + done(notice).length, 0) === 0) {
      await prisma.autopilotNotice.deleteMany({ where: { id: { in: ids } } });
      continue;
    }
    const changes: AutopilotEmailChange[] = mine.map((notice) => {
      const { codeChange } = notice;
      const goesOut = codeChange.actions.filter((action) => action.status === "SCHEDULED").map((action) => previewOf(action, now));
      const needsYou = codeChange.actions.filter((action) => action.status === "PENDING" || action.status === "STALE").map((action) => previewOf(action, now));
      // What Autopilot did by itself already: what customers see (its hold passed before this email), then drafts only the team sees, links.
      const gone = went(notice).map((action) => previewOf(action, now));
      const drafts = done(notice).map((action) => previewOf(action, now));
      return {
        title: codeChange.title,
        pullRequest: `${codeChange.repo}#${codeChange.number}`,
        summary: codeChange.summary,
        reviewUrl: `${appOrigin()}/app/${project.slug}/autopilot/${codeChange.id}?select=likely`,
        goesOut: take(goesOut),
        wentOut: take(gone),
        needsYou: take(needsYou),
        done: take(drafts),
      };
    });
    try {
      await sendEmail({
        to: mine[0]!.user.email,
        ...autopilotEmail({ projectName: project.name, changes, totals, more, autopilotUrl: `${appOrigin()}/app/${project.slug}/autopilot`, accountUrl: `${appOrigin()}/app/account` }),
      });
    } catch (error) {
      // Not sent: tried again next minute; the others still go.
      log.error("Sending Autopilot's email failed", { error, userId });
      await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, claimedAt }, data: { claimedAt: null } });
      continue;
    }
    // Sent, unless analysed again while it went: that one's left unsent, for the next email.
    const sentAt = new Date();
    for (const notice of mine) {
      await prisma.autopilotNotice.updateMany({ where: { id: notice.id, claimedAt, createdAt: notice.createdAt }, data: { sentAt } });
    }
    await prisma.autopilotNotice.updateMany({ where: { id: { in: ids }, claimedAt, sentAt: null }, data: { claimedAt: null } });
    sent++;
  }
  return sent;
}
