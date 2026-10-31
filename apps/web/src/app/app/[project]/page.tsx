import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ResumeAllButton, ScheduledButtons } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { homeOverview } from "@/server/home";
import { getMembership, isAdminRole } from "@/server/membership";
import { getSession } from "@/server/session";
import { codeChangeList } from "@/server/operations/code-changes";

/** The Feedback list's filters, from when it was the project's first page: a link with them still finds it. */
const FEEDBACK_FILTERS = ["status", "board", "sort", "show"];

/** A project's Home, where the app opens it: its numbers, Get set up, what needs the team, trending ideas, and Autopilot's paused merges. */
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
  const admin = isAdminRole(membership.role);
  const session = await getSession();
  const [overview, paused, pausedCount] = await Promise.all([
    homeOverview(membership.project.id, slug, { emailVerified: session?.user.emailVerified ?? false }),
    codeChangeList(membership.project.id, { paused: true }),
    prisma.codeChange.count({ where: { projectId: membership.project.id, state: "PAUSED" } }),
  ]);
  // On a plan without code changes, paused ones wait for the plan (codeChanges.resume refuses until then).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");

  return (
    <>
      <PageHeader title="Home" />
      {/* Four numbers, each opening its list. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ["New posts this week", overview.numbers.newPosts, `/app/${slug}/feedback?status=all&sort=new`],
            ["Need a reply", overview.numbers.needReply, `/app/${slug}/inbox`],
            ["Updates waiting", overview.numbers.updatesWaiting, `/app/${slug}/autopilot`],
            ["Searches that found nothing", overview.numbers.searchesFailed, `/app/${slug}/docs/insights`],
          ] as const
        ).map(([label, value, href]) => (
          <Link key={label} href={href} className="flex flex-col gap-1 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50">
            <span className="text-2xl font-semibold tabular-nums">{value}</span>
            <span className="text-sm text-muted-foreground">{label}</span>
          </Link>
        ))}
      </div>
      {overview.setup && admin && (
        <Card>
          <CardHeader>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              {overview.setup.filter((step) => step.done).length} of {overview.setup.length} done
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2" aria-label="Get set up">
              {overview.setup.map((step) => (
                <li key={step.key} className="flex items-center gap-2 text-sm">
                  {step.done ? <CheckCircle2Icon aria-hidden className="size-4 text-primary" /> : <CircleIcon aria-hidden className="size-4 text-muted-foreground" />}
                  {step.done ? (
                    <span className="text-muted-foreground line-through">{step.title}</span>
                  ) : (
                    <Link href={step.href} className="hover:underline">
                      {step.title}
                    </Link>
                  )}
                  <span className="sr-only">{step.done ? "(done)" : "(to do)"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Needs your attention</CardTitle>
          <CardDescription>Oldest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.attention.length === 0 ? (
            <EmptyState title="You're all caught up" description="Conversations to answer, new posts, possible duplicates and Autopilot's updates show up here." />
          ) : (
            <>
              <ItemList>
                {overview.attention.map((item) => (
                  <ItemRow
                    key={item.key}
                    title={
                      <Link href={item.href} className="hover:underline">
                        {item.title}
                      </Link>
                    }
                    badges={<Badge variant="outline">{item.kind}</Badge>}
                    meta={
                      <>
                        <span title={formatDate(item.at)}>{timeAgo(item.at)}</span>
                        {item.scheduled && (
                          <span className="block text-foreground">
                            <GoesOut at={item.scheduled.dueAt} prefix={item.scheduled.ids.length === 1 ? "1 update goes out" : `${item.scheduled.ids.length} updates go out`} />
                          </span>
                        )}
                      </>
                    }
                    actions={
                      <>
                        {item.scheduled && <ScheduledButtons projectSlug={slug} actionIds={item.scheduled.ids} />}
                        <Link href={item.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          {item.action}
                        </Link>
                      </>
                    }
                  />
                ))}
              </ItemList>
              {overview.moreAttention > 0 && <p className="mt-2 text-sm text-muted-foreground">And {overview.moreAttention} more.</p>}
            </>
          )}
        </CardContent>
      </Card>
      {overview.trending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Trending ideas</CardTitle>
            <CardDescription>The most votes in the last 7 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <ItemList>
              {overview.trending.map((post) => (
                <ItemRow
                  key={post.id}
                  title={
                    <Link href={`/app/${slug}/p/${post.number}`} className="hover:underline">
                      {post.title}
                    </Link>
                  }
                  meta={`+${post.thisWeek} this week · ${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
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
