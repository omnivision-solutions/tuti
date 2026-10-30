import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TAG_LABELS } from "@/components/changelog-entry";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { reactionSummary } from "@/lib/reactions";
import { reactionCounts } from "@/server/changelog-queries";
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
      updatedAt: true,
      _count: { select: { posts: true, pullRequests: true } },
    },
  });
  const reactions = await reactionCounts(entries.map((e) => e.id));
  const drafts = entries.filter((e) => !e.publishedAt);
  const published = entries.filter((e) => e.publishedAt);
  const tab = param === "published" || (param !== "drafts" && drafts.length === 0) ? "published" : "drafts";
  const listed = tab === "drafts" ? drafts : published;
  const base = `/app/${slug}/changelog`;
  const newEntry = (
    <Link href={`/app/${slug}/changelog/new`} className={buttonVariants()}>
      New entry
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Changelog"
        actions={newEntry}
      />
      <SubNav
        label="Entries"
        current={`${base}?tab=${tab}`}
        items={[
          { href: `${base}?tab=drafts`, title: <>Drafts <span className="text-muted-foreground tabular-nums">{drafts.length}</span></> },
          { href: `${base}?tab=published`, title: <>Published <span className="text-muted-foreground tabular-nums">{published.length}</span></> },
        ]}
      />
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
        />
      ) : (
        <Card>
          <CardContent>
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
                    ...(entry.collecting ? [<Badge key="collecting">Collecting merged PRs</Badge>] : []),
                    ...entry.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {TAG_LABELS[tag]}
                      </Badge>
                    )),
                  ]}
                  meta={[
                    entry.publishedAt ? `Published ${formatDate(entry.publishedAt)}` : "Draft",
                    `${entry._count.posts} ${entry._count.posts === 1 ? "post" : "posts"}`,
                    reactionSummary(reactions(entry.id)),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </>
  );
}
