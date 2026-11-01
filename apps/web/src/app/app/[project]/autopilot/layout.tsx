import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { cn } from "cn";
import { ClockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AutopilotPanes, ChangeLink, ChangePick } from "@/components/autopilot-list";
import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { Badge } from "@/components/ui/badge";
import { changeRow, updateChips } from "@/lib/autopilot-words";
import { formatDate, shortDuration } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { codeChangeList, type CodeChangeView, waitingUpdates } from "@/server/operations/code-changes";

/** An update chip's colour, by its kind's tone (see updateChips). */
const TONES: Record<string, string> = {
  closes: "bg-kind-closes/15 text-kind-closes",
  progress: "bg-kind-progress/15 text-kind-progress",
  edit: "bg-kind-edit/15 text-kind-edit",
  new: "bg-kind-new/15 text-kind-new",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * Autopilot: every merged pull request in a column, those with something for the team (updates waiting,
 * being read, failed or paused) under To review, the rest under Reviewed (those with nothing to do folded
 * away at the end), and the open one's page beside it. Approving or dismissing refreshes the route, so a
 * change moves to Reviewed by itself. A waiting change's ring (how sure Autopilot is of its updates, on
 * average) picks it, to approve several at once; its chips open an update each.
 */
export default async function AutopilotLayout({ children, params }: LayoutProps<"/app/[project]/autopilot">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  // To review in full (it's the team's queue); the rest, the latest.
  const [toReview, latest, { plan }] = await Promise.all([
    codeChangeList(projectId, { toReview: true }),
    codeChangeList(projectId),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } }),
  ]);
  // On a plan without Autopilot, those here are kept but can't be analysed (codeChanges.analyse refuses).
  const included = planIncludes(plan, "codeChanges");
  const queued = new Set(toReview.map((change) => change.id));
  const rest = latest.filter((change) => !queued.has(change.id));
  const waiting = await waitingUpdates(projectId, toReview.filter((change) => change.waiting > 0).map((change) => change.id));
  const row = (change: CodeChangeView) => {
    const { badge, reason, action } = changeRow(change);
    const href = `/app/${slug}/autopilot/${change.id}`;
    const mine = waiting.get(change.id);
    return {
      id: change.id,
      title: change.title,
      likely: mine?.likely ?? [],
      row: (
        // Two lines: the title (the whole row opens it; cut to a line, in full on hover) and when it merged; its
        // updates' chips (each cut short when they don't fit), or its state.
        <li key={change.id} className="relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 has-[a[aria-current=page]]:bg-muted">
          {mine ? <ChangePick id={change.id} title={change.title} sure={mine.sure} likely={mine.likely.length} /> : queued.has(change.id) && <span className="size-7 shrink-0" />}
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
                    href={`${href}?show=${chip.id}`}
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
  // Reviewed: the rest, read, with nothing waiting for the team (done, or going out by itself).
  return (
    <AutopilotPanes
      projectSlug={slug}
      toReview={toReview.map(row)}
      reviewed={rest.filter((change) => change.state !== "nothing_to_do").map(row)}
      nothingToDo={rest.filter((change) => change.state === "nothing_to_do").map(row)}
    >
      {children}
    </AutopilotPanes>
  );
}
