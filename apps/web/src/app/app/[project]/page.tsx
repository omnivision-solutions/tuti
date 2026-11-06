import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { AppWindowIcon, BookOpenIcon, CheckCircle2Icon, GitMergeIcon, InboxIcon, KeyRoundIcon, type LucideIcon, MegaphoneIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ResumeAllButton, ScheduledButtons } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { InvitationsToSend, RefreshWhile } from "@/components/setup-import";
import { AddSampleContent, RemoveSampleContent } from "@/components/sample-content";
import { StatTile } from "@/components/stat-tile";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDate, timeAgo } from "@/lib/format";
import { homeInvitationsToSend, importSee, importSummary, importTitle, onHome } from "@/lib/import-parts";
import { homeOverview } from "@/server/home";
import { hasSampleContent } from "@/server/sample-content";
import { getMembership, isAdminRole } from "@/server/membership";
import { codeChangeList } from "@/server/operations/code-changes";
import { latestImport } from "@/server/operations/imports";

/** Get set up's steps' icons, by step. */
const SETUP_ICONS: Record<string, LucideIcon> = {
  widget: AppWindowIcon,
  github: GitMergeIcon,
  sso: KeyRoundIcon,
  support: InboxIcon,
  article: BookOpenIcon,
  changelog: MegaphoneIcon,
  team: UserPlusIcon,
};

/** The Feedback list's filters, from when it was the project's first page: a link with them still finds it. */
const FEEDBACK_FILTERS = ["status", "board", "sort", "show"];

/** A project's Home, where the app opens it: its numbers, Get set up, what needs the team, trending feedback, and Autopilot's paused merges. */
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
  const [overview, paused, pausedCount, sample] = await Promise.all([
    homeOverview(membership.project.id, slug),
    codeChangeList(membership.project.id, { paused: true }),
    prisma.codeChange.count({ where: { projectId: membership.project.id, state: "PAUSED" } }),
    hasSampleContent(membership.project.id),
  ]);
  // On a plan without code changes, paused ones wait for the plan (codeChanges.resume refuses until then).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");
  // An import (owners and admins): while it runs, and its result for a few days after.
  const imported = admin ? await latestImport(membership.project.id) : null;
  const importShown = imported && onHome(imported);

  return (
    <>
      <PageHeader title="Home" />
      {/* Four numbers, each opening its list; not while the project has nothing of its own and all four are 0. */}
      {(overview.started || Object.values(overview.numbers).some((n) => n > 0)) && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              ["New posts this week", overview.numbers.newPosts, `/app/${slug}/feedback?status=all&sort=new`],
              ["Need a reply", overview.numbers.needReply, `/app/${slug}/inbox`],
              ["Posts and articles to review", overview.numbers.toReview, `/app/${slug}/autopilot`],
              ["Searches that found nothing", overview.numbers.searchesFailed, `/app/${slug}/reporting/searches`],
            ] as const
          ).map(([label, value, href]) => (
            <StatTile key={label} value={value} label={label} href={href} />
          ))}
        </div>
      )}
      {sample && admin && (
        <Card>
          <CardHeader>
            <CardTitle>Sample content</CardTitle>
            <CardDescription>Here to try things with, labelled Sample in your lists and on the portal&apos;s boards, docs and changelog. Home&apos;s numbers leave it out.</CardDescription>
            <CardAction>
              <RemoveSampleContent projectSlug={slug} />
            </CardAction>
          </CardHeader>
        </Card>
      )}
      {importShown && (
        <Card>
          <RefreshWhile on={imported.state === "running"} />
          <CardHeader>
            <CardTitle>{importTitle(imported)}</CardTitle>
            <CardDescription>{importSummary(imported)}</CardDescription>
            {/* Heard when it starts and ends, not with each page's count while it runs. */}
            <p role="status" className="sr-only">
              {imported.state === "running" ? importTitle(imported) : `${importTitle(imported)}. ${importSummary(imported)}`}
            </p>
            {imported.state === "failed" ? (
              <CardAction>
                <Link href={`/app/${slug}/setup`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Start again
                </Link>
              </CardAction>
            ) : imported.state === "done" && importSee(imported) ? (
              <CardAction>
                <Link href={`/app/${slug}/${importSee(imported)!.page}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {importSee(imported)!.label}
                </Link>
              </CardAction>
            ) : null}
          </CardHeader>
          {homeInvitationsToSend(imported, admin) > 0 && (
            <CardContent>
              <InvitationsToSend projectSlug={slug} count={homeInvitationsToSend(imported, admin)} />
            </CardContent>
          )}
        </Card>
      )}
      {overview.setup && admin && (
        <Card>
          <CardHeader>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              {overview.setup.filter((step) => step.done).length} of {overview.setup.length} done
            </CardDescription>
            <CardAction className="self-center">
              <Progress aria-label="Steps done" value={overview.setup.filter((step) => step.done).length} max={overview.setup.length} className="w-28 sm:w-36" />
            </CardAction>
          </CardHeader>
          <CardContent>
            {/* A card per step, two to a row: what it's for under its title, its own button. Done ones last; the first left to do stands out (its border and icon in green, its button an outline: the page's one primary is elsewhere). */}
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Get set up">
              {overview.setup.map((step, i) => {
                const Icon = step.done ? CheckCircle2Icon : SETUP_ICONS[step.key]!;
                const next = i === 0 && !step.done;
                return (
                  <li key={step.key} className={`flex min-w-0 flex-col gap-3 rounded-xl border p-4 ${next ? "border-primary/50" : ""}`}>
                    <div className="flex items-center gap-3">
                      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${step.done ? "text-primary" : next ? "bg-soft text-soft-foreground" : "bg-muted text-muted-foreground"}`}>
                        <Icon aria-hidden className="size-[18px]" />
                      </span>
                      <span id={`setup-${step.key}`} className={`text-sm font-medium ${step.done ? "text-muted-foreground" : ""}`}>
                        {step.title}
                      </span>
                      <span className="sr-only">{step.done ? "(done)" : "(to do)"}</span>
                    </div>
                    {/* The project's name is in some: a long one wraps rather than running out of the card. */}
                    <p className="text-sm wrap-anywhere text-muted-foreground">{step.description}</p>
                    {/* Each step left to do with its own action, a button rather than a link in the text. */}
                    {!step.done && (
                      // Described by its step, which screen readers then read with it ("Connect", Connect GitHub).
                      <Link
                        href={step.href}
                        aria-describedby={`setup-${step.key}`}
                        className={buttonVariants({ variant: "outline", size: "sm", className: "mt-auto self-start" })}
                      >
                        {step.action}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Needs your attention</CardTitle>
          {/* Sample content until the project has content of its own: here once the card lists something, in its empty state until then. */}
          {admin && !sample && !overview.started && overview.attention.length > 0 && (
            <CardAction>
              <AddSampleContent projectSlug={slug} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {overview.attention.length > 0 ? (
            <div className="flex flex-col gap-6">
              {/* By kind, customers waiting first; each kind's oldest few, and its list for the rest. */}
              {overview.attention.map((group) => (
                <section key={group.key} aria-label={group.title} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-medium">
                      {group.title} <span className="text-muted-foreground tabular-nums">{group.total}</span>
                    </h3>
                    <Link href={group.href} aria-label={`${group.link ?? "See all"}: ${group.title}`} className="shrink-0 text-sm text-muted-foreground hover:text-foreground hover:underline">
                      {group.link ?? "See all"}
                    </Link>
                  </div>
                  <ItemList>
                    {group.items.map((item) => (
                      <ItemRow
                        key={item.key}
                        title={
                          <Link href={item.href} className="hover:underline">
                            {item.title}
                          </Link>
                        }
                        meta={
                          <>
                            <span title={formatDate(item.at)}>{timeAgo(item.at)}</span>
                            {item.scheduled && (
                              <>
                                {" · "}
                                <GoesOut at={item.scheduled.dueAt} prefix={item.scheduled.ids.length === 1 ? "1 update goes out" : `${item.scheduled.ids.length} updates go out, the first`} />
                              </>
                            )}
                          </>
                        }
                        // Stop, Publish now and Review: under the title on phones, which keeps the width.
                        wideActions={item.scheduled !== undefined}
                        actions={
                          <>
                            {/* Its buttons the row's own, so on phones Stop, Publish now and Review share its width. */}
                            {item.scheduled && (
                              <ScheduledButtons projectSlug={slug} actionIds={item.scheduled.ids} emails={item.scheduled.emails} posts={item.scheduled.posts} className="contents" />
                            )}
                            <Link href={item.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
                              {item.action}
                            </Link>
                          </>
                        }
                      />
                    ))}
                  </ItemList>
                </section>
              ))}
            </div>
          ) : overview.started ? (
            <EmptyState title="You're all caught up" description="Conversations to answer, Autopilot's updates, new posts, possible duplicates and failed searches show up here." />
          ) : (
            <EmptyState
              title="Nothing here yet"
              description={admin && !sample ? "Share your portal or add the widget: new posts show up here. Or add sample content to try things with." : "Share your portal or add the widget: new posts show up here."}
              action={
                admin && (
                  // Sample content is the main way in, until there is some: the primary, on the right.
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link href={`/app/${slug}/setup`} className={buttonVariants({ variant: sample ? "default" : "outline" })}>
                      Set up your project
                    </Link>
                    {!sample && <AddSampleContent projectSlug={slug} />}
                  </div>
                )
              }
            />
          )}
        </CardContent>
      </Card>
      {overview.trending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Trending feedback</CardTitle>
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
                    <Link href={`/app/${slug}/autopilot/activity/${change.id}`} className="hover:underline">
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
