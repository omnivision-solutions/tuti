import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AutopilotPanes, ChangeLink } from "@/components/autopilot-list";
import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { ItemRow } from "@/components/item-list";
import { Badge } from "@/components/ui/badge";
import { formatDate, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { codeChangeList, type CodeChangeView } from "@/server/operations/code-changes";

/**
 * Autopilot: every merged pull request in a column, those with something for the team (updates waiting,
 * being read, failed or paused) under To review, the rest under Reviewed (those with nothing to do folded
 * away at the end), and the open one's page beside it. Approving or dismissing refreshes the route, so a
 * change moves to Reviewed by itself.
 */
export default async function AutopilotLayout({ children, params }: LayoutProps<"/app/[project]/autopilot">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [changes, { plan }] = await Promise.all([
    codeChangeList(projectId),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } }),
  ]);
  // None yet: the page says why, on its own.
  if (changes.length === 0) {
    return children;
  }
  // On a plan without Autopilot, those here are kept but can't be analysed (codeChanges.analyse refuses).
  const included = planIncludes(plan, "codeChanges");
  const lines = await updatesInALine(changes.filter((change) => change.waiting > 0).map((change) => change.id));
  const row = (change: CodeChangeView) => ({
    id: change.id,
    row: (
      <ItemRow
        key={change.id}
        className="-mx-2 rounded-md px-2 first:pt-2.5 last:pb-2.5 has-[a[aria-current=page]]:bg-muted"
        title={<ChangeLink href={`/app/${slug}/autopilot/${change.id}`}>{change.title}</ChangeLink>}
        badges={<StateBadge change={change} />}
        meta={
          <>
            @{change.author} · <span title={formatDate(new Date(change.mergedAt))}>merged {timeAgo(new Date(change.mergedAt))}</span>
            {(change.state === "nothing_to_do" || change.state === "paused") && change.reason && ` · ${change.reason}`}
            {lines.get(change.id) && <span className="block text-foreground">{lines.get(change.id)}</span>}
            {change.nextDueAt && (
              <span className="block text-foreground">
                <GoesOut at={change.nextDueAt} prefix={change.scheduled.length === 1 ? "1 update goes out" : `${change.scheduled.length} updates go out, the first`} />
              </span>
            )}
          </>
        }
        actions={
          included && (change.state === "nothing_to_do" || change.state === "paused") ? (
            <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label={change.state === "paused" ? "Resume" : "Analyse anyway"} />
          ) : undefined
        }
      />
    ),
  });
  // Reviewed: read, with nothing waiting for the team (done, or going out by itself).
  const reviewed = (change: CodeChangeView) => change.state === "ready" && change.waiting === 0;

  return (
    <AutopilotPanes
      projectSlug={slug}
      toReview={changes.filter((change) => change.state !== "nothing_to_do" && !reviewed(change)).map(row)}
      reviewed={changes.filter(reviewed).map(row)}
      nothingToDo={changes.filter((change) => change.state === "nothing_to_do").map(row)}
    >
      {children}
    </AutopilotPanes>
  );
}

function StateBadge({ change }: { change: CodeChangeView }) {
  switch (change.state) {
    case "analysing":
      return <Badge variant="secondary">Analysing</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "paused":
      return <Badge variant="secondary">Paused</Badge>;
    case "ready":
      return change.waiting > 0 ? <Badge variant="highlight">{change.waiting} to review</Badge> : null;
    default:
      return null;
  }
}

/**
 * Each change's updates waiting for the team, in a line: "Closes Dark mode · updates 1 article ·
 * changelog line" (the first post it closes or moves forward by name, the rest counted), by change id.
 */
async function updatesInALine(changeIds: string[]): Promise<Map<string, string>> {
  const actions = await prisma.codeChangeAction.findMany({
    where: { codeChangeId: { in: changeIds }, status: { in: ["PENDING", "STALE"] } },
    orderBy: [{ probability: "desc" }, { id: "asc" }],
    select: { codeChangeId: true, kind: true, post: { select: { title: true } } },
  });
  const lines = new Map<string, string>();
  for (const id of changeIds) {
    const mine = actions.filter((action) => action.codeChangeId === id);
    const count = (...kinds: string[]) => mine.filter((action) => kinds.includes(action.kind)).length;
    // Named by a post it has (one deleted since leaves the action without).
    const closes = mine.find((action) => action.kind === "RESOLVES" && action.post);
    const forward = mine.find((action) => action.kind === "MOVES_FORWARD" && action.post);
    const parts = [
      closes && `Closes ${closes.post!.title}${count("RESOLVES") > 1 ? ` and ${count("RESOLVES") - 1} more` : ""}`,
      forward && `Progress on ${forward.post!.title}${count("MOVES_FORWARD") > 1 ? ` and ${count("MOVES_FORWARD") - 1} more` : ""}`,
      count("LINKS") > 0 && `links ${count("LINKS")} ${count("LINKS") === 1 ? "post" : "posts"}`,
      count("ARTICLE_EDIT") > 0 && `updates ${count("ARTICLE_EDIT")} ${count("ARTICLE_EDIT") === 1 ? "article" : "articles"}`,
      count("NEW_ARTICLE") > 0 && `${count("NEW_ARTICLE")} new ${count("NEW_ARTICLE") === 1 ? "article" : "articles"}`,
      count("CHANGELOG_LINE") > 0 && "changelog line",
    ].filter(Boolean);
    if (parts.length > 0) {
      lines.set(id, parts.join(" · "));
    }
  }
  return lines;
}
