import { prisma } from "@tuti/db";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TagBadge } from "@/components/changelog-tag";
import { EmptyState } from "@/components/empty-state";
import { FilterPills } from "@/components/filter-pills";
import { ItemList, ItemRow } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { SampleBadge } from "@/components/sample-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, timeAgo } from "@/lib/format";
import { reactionSummary } from "@/lib/reactions";
import { draftToWrite, reactionCounts } from "@/server/changelog-queries";
import { getMembership } from "@/server/membership";

/**
 * The team's changelog, in two tabs: Drafts (latest edited first) and Published (newest first). It opens
 * on Drafts, or on Published when there are none.
 */
export default async function TeamChangelogPage(props: PageProps<"/app/[project]/changelog">) {
  const { project: slug } = await props.params;
  const { tab: param } = await props.searchParams;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const entries = await prisma.changelogEntry.findMany({
    where: { projectId: membership.project.id },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
    select: {
      id: true,
      number: true,
      title: true,
      tags: true,
      publishedAt: true,
      collecting: true,
      sample: true,
      updatedAt: true,
      _count: { select: { posts: true, pullRequests: true } },
    },
  });
  const reactions = await reactionCounts(entries.map((e) => e.id));
  const drafts = entries.filter((e) => !e.publishedAt);
  const published = entries.filter((e) => e.publishedAt);
  // Release notes waiting to be written: the draft the newest release closed, else the running one with merged pull requests.
  const ready = await draftToWrite(membership.project.id);
  const tab = param === "published" || (param !== "drafts" && drafts.length === 0) ? "published" : "drafts";
  const listed = tab === "drafts" ? drafts : published;
  const base = `/app/${slug}/changelog`;
  const newEntry = (
    // A round + on phones.
    <Link href={`/app/${slug}/changelog/new`} className={buttonVariants({ size: "sm", className: "@max-[48rem]/app:size-9 @max-[48rem]/app:px-0" })}>
      <PlusIcon aria-hidden />
      <span className="@max-[48rem]/app:sr-only">New entry</span>
    </Link>
  );

  return (
    <PaneLayout>
      <Pane aria-label="Changelog">
        <PaneHeader
          title="Changelog"
          description="What you shipped, for your users to read."
          filters={
            <FilterPills
              label="Entries"
              current={`${base}?tab=${tab}`}
              // The count in the title: its space keeps the link's name "Drafts 2".
              items={[
                { href: `${base}?tab=drafts`, title: <>Drafts <span className="text-muted-foreground tabular-nums">{drafts.length}</span></> },
                { href: `${base}?tab=published`, title: <>Published <span className="text-muted-foreground tabular-nums">{published.length}</span></> },
              ]}
            />
          }
          actions={newEntry}
        />
        <PaneBody className="flex flex-col gap-4 p-4 @min-[48rem]/app:px-5">
          {ready && (
            <Alert role="status">
              {/* The running draft isn't a release yet: it collects until the next one. */}
              <AlertTitle>
                {!ready.collecting
                  ? "Next release is ready to write"
                  : ready._count.pullRequests === 1
                    ? "A merged pull request is waiting for release notes"
                    : "Merged pull requests are waiting for release notes"}
              </AlertTitle>
              <AlertDescription className="break-words">
                {ready._count.pullRequests} merged pull {ready._count.pullRequests === 1 ? "request is" : "requests are"} in “{ready.title}”
                {ready.collecting ? ", collecting until the next release." : "."}
              </AlertDescription>
              <AlertAction>
                <Link href={`/app/${slug}/changelog/${ready.number}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Write it
                </Link>
              </AlertAction>
            </Alert>
          )}
          {listed.length === 0 ? (
            <EmptyState
              title={entries.length === 0 ? "No entries yet" : tab === "drafts" ? "No drafts" : "Nothing published yet"}
              description={
                entries.length === 0
                  ? "Write what shipped and pick the posts it completes."
                  : tab === "drafts"
                    ? "With GitHub connected, merged pull requests gather in a draft until the next release."
                    : "Published entries show on your portal."
              }
              action={
                entries.length === 0 && (
                  // Outline: the header's New entry is the page's primary.
                  <Link href={`/app/${slug}/changelog/new`} className={buttonVariants({ variant: "outline" })}>
                    Write the first entry
                  </Link>
                )
              }
            />
          ) : (
            <ItemList>
              {listed.map((entry) => (
                <ItemRow
                  key={entry.number}
                  title={
                    <Link href={`/app/${slug}/changelog/${entry.number}`} className="hover:underline">
                      {entry.title}
                    </Link>
                  }
                  badges={[
                    ...(entry.sample ? [<SampleBadge key="sample" />] : []),
                    ...(entry.collecting ? [<Badge key="collecting" variant="outline">Collecting pull requests</Badge>] : []),
                    ...entry.tags.map((tag) => <TagBadge key={tag} tag={tag} />),
                  ]}
                  // A draft says when it was last touched and what it holds so far (none: nothing); a published entry, when it went out.
                  meta={[
                    entry.publishedAt ? `Published ${formatDate(entry.publishedAt)}` : `Edited ${timeAgo(entry.updatedAt)}`,
                    (entry.publishedAt || entry._count.posts > 0) && `${entry._count.posts} ${entry._count.posts === 1 ? "post" : "posts"}`,
                    !entry.publishedAt &&
                      entry._count.pullRequests > 0 &&
                      `${entry._count.pullRequests} merged pull ${entry._count.pullRequests === 1 ? "request" : "requests"}`,
                    reactionSummary(reactions(entry.id)),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </ItemList>
          )}
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
