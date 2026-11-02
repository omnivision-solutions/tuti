import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { cn } from "cn";
import { ClockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AutopilotPanes, ChangeLink, ChangePick } from "@/components/autopilot-list";
import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { PullRequestChip } from "@/components/pull-request-chip";
import { TargetBadge, TONES } from "@/components/target-badge";
import { Badge } from "@/components/ui/badge";
import { changeRow, updateChips } from "@/lib/autopilot-words";
import { formatDate, shortDuration } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { type AutopilotTarget, autopilotTargets, codeChangeList, type CodeChangeView, waitingUpdates } from "@/server/operations/code-changes";

/** Autopilot's sections, in their order. */
const SECTIONS = { feedback: "Feedback", help_center: "Help center" } as const;

/**
 * Autopilot: what it updates in a column, under To review (updates waiting for the team or going out by themselves)
 * and Reviewed, each in two sections, Feedback (posts on every board) then Help center (articles, and new articles'
 * drafts); and Activity, every merged pull request (those with nothing to do folded away at the end). The open one's
 * page is beside it. Approving or dismissing refreshes the route, so a post or article moves to Reviewed by itself.
 * A waiting one's ring (how sure Autopilot is of its updates, on average) picks it, to approve several at once.
 */
export default async function AutopilotLayout({ children, params }: LayoutProps<"/app/[project]/autopilot">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  // To review in full (it's the team's queue); the rest, the latest.
  const [targets, decided, toReview, latest, { plan }] = await Promise.all([
    autopilotTargets(projectId),
    autopilotTargets(projectId, { decided: true }),
    codeChangeList(projectId, { toReview: true }),
    codeChangeList(projectId),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } }),
  ]);
  // On a plan without Autopilot, those here are kept but can't be analysed (codeChanges.analyse refuses).
  const included = planIncludes(plan, "codeChanges");
  const queued = new Set(toReview.map((change) => change.id));
  const rest = latest.filter((change) => !queued.has(change.id));
  const waiting = await waitingUpdates(projectId, toReview.filter((change) => change.waiting > 0).map((change) => change.id));
  // A post or article: its title (the whole row opens it; cut to a line, in full on hover) and its badge; its pull
  // requests' chips, and when its updates go out by themselves.
  const targetRow = (target: AutopilotTarget, waits: boolean) => {
    const href = `/app/${slug}/autopilot/${target.path}`;
    return {
      id: target.path,
      title: target.title,
      section: SECTIONS[target.section],
      likely: target.likely,
      row: (
        <li key={target.path} className="relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 has-[a[aria-current=page]]:bg-muted">
          {waits && <ChangePick id={target.path} title={target.title} sure={target.sure} likely={target.likely.length} />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <ChangeLink href={href} title={target.title} className="truncate text-sm font-medium after:absolute after:inset-0">
                {target.title}
              </ChangeLink>
              <TargetBadge badge={target.badge} className="ml-auto" />
            </div>
            <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground">
              {/* Over the row's link (it covers the row), so their cards open. */}
              {target.pullRequests.slice(0, 2).map((pr) => (
                <PullRequestChip key={pr.id} projectSlug={slug} pr={pr} compact />
              ))}
              {target.pullRequests.length > 2 && <span className="shrink-0">+{target.pullRequests.length - 2}</span>}
              {target.nextDueAt && (
                <span className="min-w-0 truncate pl-1">
                  <GoesOut at={target.nextDueAt} prefix={target.waiting > 0 ? "Some go out" : "Goes out"} />
                </span>
              )}
            </div>
          </div>
        </li>
      ),
    };
  };
  const row = (change: CodeChangeView) => {
    const { badge, reason, action } = changeRow(change);
    const href = `/app/${slug}/autopilot/activity/${change.id}`;
    const mine = waiting.get(change.id);
    return {
      id: `activity/${change.id}`,
      title: change.title,
      row: (
        // Two lines: the title (the whole row opens it; cut to a line, in full on hover) and when it merged; its
        // updates' chips (each cut short when they don't fit), or its state.
        <li key={change.id} className="relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 has-[a[aria-current=page]]:bg-muted">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <ChangeLink href={href} title={change.title} className="truncate text-sm font-medium after:absolute after:inset-0">
                {change.title}
              </ChangeLink>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={`Merged ${formatDate(new Date(change.mergedAt))}`}>
                {shortDuration(new Date(change.mergedAt))}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground">
              {/* Over the row's link (it covers the row), so their hover shows; opening the change too (by mouse: the
                  title's link is the keyboard's). */}
              {badge && (
                <Link href={href} tabIndex={-1} className="relative z-10 shrink-0">
                  <Badge variant={badge.variant} title={reason ?? undefined}>
                    {badge.label}
                    {/* Why it's paused, beside chips (without them, it's the line's text); its page says so too. */}
                    {mine && reason && <span className="sr-only">: {reason}</span>}
                  </Badge>
                </Link>
              )}
              {mine &&
                updateChips(mine.updates).map((chip) => (
                  <Link
                    key={chip.kind}
                    href={href}
                    tabIndex={-1}
                    title={chip.label}
                    className={cn("relative z-10 min-w-0 truncate rounded-full px-2 py-0.5 text-[0.6875rem] font-medium hover:underline", TONES[chip.tone])}
                  >
                    {chip.label}
                  </Link>
                ))}
              {/* Beside chips: a clock when updates go out by themselves, "auto-updating" (the badge's hover says why it's paused). Without:
                  why it's paused, or when one goes out, or who merged it. */}
              {mine ? (
                change.nextDueAt && (
                  <Link href={href} tabIndex={-1} className="relative z-10 shrink-0">
                    <ClockIcon
                      role="img"
                      aria-label={`${change.scheduled.length} auto-updating`}
                      className="size-3.5"
                    >
                      <title>{`${change.scheduled.length} auto-updating`}</title>
                    </ClockIcon>
                  </Link>
                )
              ) : (
                <span className="min-w-0 truncate">
                  {reason ??
                    (change.nextDueAt ? (
                      <GoesOut at={change.nextDueAt} prefix={change.scheduled.length === 1 ? "1 update goes out" : `${change.scheduled.length} updates go out, the first`} />
                    ) : (
                      `@${change.author}`
                    ))}
                </span>
              )}
            </div>
          </div>
          {included && action && (
            <span className="relative z-10 shrink-0">
              <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label={action} />
            </span>
          )}
        </li>
      ),
    };
  };
  // Activity: every pull request, those with something for the team first; those with nothing to do folded away.
  const changes = [...toReview, ...rest].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  return (
    <AutopilotPanes
      projectSlug={slug}
      toReview={[...targets.feedback, ...targets.helpCenter].map((target) => targetRow(target, true))}
      reviewed={[...decided.feedback, ...decided.helpCenter].map((target) => targetRow(target, false))}
      activity={changes.filter((change) => change.state !== "nothing_to_do" || change.waiting > 0).map(row)}
      nothingToDo={changes.filter((change) => change.state === "nothing_to_do" && change.waiting === 0).map(row)}
      unread={changes.filter((change) => change.state === "analysing" || change.state === "failed" || change.state === "paused").length}
    >
      {children}
    </AutopilotPanes>
  );
}
