import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ResumeAllButton } from "@/components/code-changes";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { codeChangeList } from "@/server/operations/code-changes";

/** The Feedback list's filters, from when it was the project's first page: a link with them still finds it. */
const FEEDBACK_FILTERS = ["status", "board", "sort", "show"];

/** A project's Home, where the app opens it: Catch up, what's waiting for the team. */
export default async function HomePage(props: PageProps<"/app/[project]">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  if (FEEDBACK_FILTERS.some((name) => searchParams[name] !== undefined)) {
    const query = new URLSearchParams(Object.entries(searchParams).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));
    redirect(`/app/${slug}/feedback?${query}`);
  }
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const [waiting, paused, pausedCount] = await Promise.all([
    codeChangeList(membership.project.id, { waiting: true }),
    codeChangeList(membership.project.id, { paused: true }),
    prisma.codeChange.count({ where: { projectId: membership.project.id, state: "PAUSED" } }),
  ]);
  // On a plan without code changes, paused ones wait for the plan (codeChanges.resume refuses until then).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");

  return (
    <>
      <PageHeader title="Home" />
      <Card>
        <CardHeader>
          <CardTitle>Catch up</CardTitle>
          <CardDescription>Merged pull requests with updates from Autopilot waiting for your team: requests it closes, docs to update, a changelog line.</CardDescription>
        </CardHeader>
        <CardContent>
          {waiting.length === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="When a merged pull request changes something your users see, it shows up here to review."
              action={
                <Link href={`/app/${slug}/autopilot`} className={buttonVariants({ variant: "outline" })}>
                  Autopilot
                </Link>
              }
            />
          ) : (
            <ItemList>
              {waiting.slice(0, 10).map((change) => (
                <ItemRow
                  key={change.id}
                  title={
                    <Link href={`/app/${slug}/autopilot/${change.id}`} className="hover:underline">
                      {change.title}
                    </Link>
                  }
                  badges={<Badge variant="highlight">{change.waiting} to review</Badge>}
                  meta={
                    <>
                      {change.repo}#{change.number} · @{change.author} ·{" "}
                      <span title={formatDate(new Date(change.mergedAt))}>merged {timeAgo(new Date(change.mergedAt))}</span>
                    </>
                  }
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
      {paused.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Paused</CardTitle>
            <CardDescription>
              {included
                ? "Merged pull requests not analysed yet: the project ran out of AI credits. Resume them once it has more."
                : "Merged pull requests not analysed yet: this project's plan doesn't include Autopilot. They wait for it."}
            </CardDescription>
            {included && (
              <CardAction>
                <ResumeAllButton projectSlug={slug} />
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <ItemList>
              {paused.slice(0, 10).map((change) => (
                <ItemRow
                  key={change.id}
                  title={
                    <Link href={`/app/${slug}/autopilot/${change.id}`} className="hover:underline">
                      {change.title}
                    </Link>
                  }
                  badges={<Badge variant="secondary">Paused</Badge>}
                  meta={
                    <>
                      {change.repo}#{change.number} · @{change.author} ·{" "}
                      <span title={formatDate(new Date(change.mergedAt))}>merged {timeAgo(new Date(change.mergedAt))}</span>
                    </>
                  }
                />
              ))}
            </ItemList>
            {pausedCount > 10 && (
              <p className="mt-2 text-sm text-muted-foreground">
                And {pausedCount - 10} more in Autopilot{included && "; Resume all resumes them too"}.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
