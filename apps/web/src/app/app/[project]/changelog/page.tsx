import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TAG_LABELS, type TagName } from "@/components/changelog";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { getMembership } from "@/server/membership";

/** The team's changelog: drafts first (latest edited), then what's published (newest first). */
export default async function TeamChangelogPage(props: PageProps<"/app/[project]/changelog">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const entries = await prisma.changelogEntry.findMany({
    where: { projectId: membership.project.id },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
    select: {
      number: true,
      title: true,
      tags: true,
      publishedAt: true,
      collecting: true,
      updatedAt: true,
      _count: { select: { posts: true, pullRequests: true } },
    },
  });
  const newEntry = (
    <Link href={`/app/${slug}/changelog/new`} className={buttonVariants()}>
      New entry
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Changelog"
        description="What shipped, for the people who asked. Published entries show on your portal. With GitHub connected, merged pull requests gather in a draft until the next release."
        actions={newEntry}
      />
      {entries.length === 0 ? (
        <EmptyState title="No entries yet" description="Write what shipped and pick the posts it completes." />
      ) : (
        <Card>
          <CardContent>
            <ItemList>
              {entries.map((entry) => (
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
                        {TAG_LABELS[tag.toLowerCase() as TagName]}
                      </Badge>
                    )),
                  ]}
                  meta={`${entry.publishedAt ? `Published ${formatDate(entry.publishedAt)}` : "Draft"} · ${entry._count.posts} ${entry._count.posts === 1 ? "post" : "posts"}`}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </>
  );
}
