import { prisma } from "@tuti/db";
import { codeChangesEnabled, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { codeChangeList, type CodeChangeView } from "@/server/operations/code-changes";

/** Autopilot: every merged pull request with the updates it found; those with nothing to do folded away at the end. */
export default async function CodeChangesPage(props: PageProps<"/app/[project]/autopilot">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [changes, connection] = await Promise.all([
    codeChangeList(projectId),
    prisma.githubInstallation.findUnique({ where: { projectId }, select: { project: { select: { analyseCodeChanges: true } } } }),
  ]);
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
  // On a plan without Autopilot, those here are kept but can't be analysed (codeChanges.analyse refuses).
  const included = planIncludes(plan, "codeChanges");
  const listed = changes.filter((change) => change.state !== "nothing_to_do");
  const lines = await updatesInALine(listed.filter((change) => change.waiting > 0).map((change) => change.id));
  const nothingToDo = changes.filter((change) => change.state === "nothing_to_do");
  const row = (change: CodeChangeView) => (
    <ItemRow
      key={change.id}
      title={
        <Link href={`/app/${slug}/autopilot/${change.id}`} className="hover:underline">
          {change.title}
        </Link>
      }
      badges={<StateBadge change={change} />}
      meta={
        <>
          {change.repo}#{change.number} · @{change.author} ·{" "}
          <span title={formatDate(new Date(change.mergedAt))}>merged {timeAgo(new Date(change.mergedAt))}</span>
          {(change.state === "nothing_to_do" || change.state === "paused") && change.reason && ` · ${change.reason}`}
          {lines.get(change.id) && <span className="block text-foreground">{lines.get(change.id)}</span>}
        </>
      }
      actions={
        included && (change.state === "nothing_to_do" || change.state === "paused") ? (
          <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label={change.state === "paused" ? "Resume" : "Analyse anyway"} />
        ) : undefined
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Autopilot"
      />
      {!included && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin={membership.role !== "MEMBER"}>
          Merged pull requests still go into the changelog&apos;s running draft, and what Autopilot found already is kept.
        </PlanNotice>
      )}
      {changes.length === 0 ? (
        <EmptyState
          title="Nothing from Autopilot yet"
          description={
            !codeChangesEnabled()
              ? "Autopilot needs AI on this server (OPENROUTER_API_KEY and OPENAI_API_KEY in .env.example)."
              : !included
                ? "On this project's plan, merged pull requests go into the changelog's running draft only."
                : !connection
                ? "Connect GitHub and add your repositories: each pull request merged there shows up here."
                : !connection.project.analyseCodeChanges
                  ? "Autopilot is off for this project. Turn it on in GitHub's settings."
                  : "Each pull request merged on your repositories shows up here, with the requests it closes and the docs it changes."
          }
          action={
            codeChangesEnabled() && included && (!connection || !connection.project.analyseCodeChanges) && membership.role !== "MEMBER" ? (
              <Link href={`/app/${slug}/settings/integrations${connection ? "/github" : ""}`} className={buttonVariants({ variant: "outline" })}>
                {connection ? "GitHub settings" : "Connect GitHub"}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          {listed.length > 0 && (
            <Card>
              <CardContent>
                <ItemList>{listed.map(row)}</ItemList>
              </CardContent>
            </Card>
          )}
          {nothingToDo.length > 0 && (
            <Card>
              <details>
                <summary className="cursor-pointer px-(--card-spacing) font-heading text-base font-medium">Nothing to do ({nothingToDo.length})</summary>
                <CardContent className="pt-4">
                  <ItemList>{nothingToDo.map(row)}</ItemList>
                </CardContent>
              </details>
            </Card>
          )}
        </>
      )}
    </>
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
      return change.waiting > 0 ? <Badge variant="highlight">{change.waiting} to review</Badge> : <Badge variant="outline">Reviewed</Badge>;
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
