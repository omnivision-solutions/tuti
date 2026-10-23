import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const waiting = (await codeChangeList(membership.project.id)).filter((change) => change.waiting > 0);

  return (
    <>
      <PageHeader title="Home" description={`What's waiting for the ${membership.project.name} team.`} />
      <Card>
        <CardHeader>
          <CardTitle>Catch up</CardTitle>
          <CardDescription>Merged pull requests with proposals waiting for your team: posts to complete, docs to update, a changelog line.</CardDescription>
        </CardHeader>
        <CardContent>
          {waiting.length === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="When a merged pull request changes something your users see, it shows up here to review."
              action={
                <Link href={`/app/${slug}/code-changes`} className={buttonVariants({ variant: "outline" })}>
                  Code changes
                </Link>
              }
            />
          ) : (
            <ItemList>
              {waiting.slice(0, 10).map((change) => (
                <ItemRow
                  key={change.id}
                  title={
                    <Link href={`/app/${slug}/code-changes/${change.id}`} className="hover:underline">
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
    </>
  );
}
