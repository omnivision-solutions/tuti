import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogStyleForm } from "@/components/changelog";
import { TAG_LABELS } from "@/components/changelog-entry";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  // The writing style only matters to AI drafts.
  const style =
    aiEnabled() &&
    (await prisma.project.findUniqueOrThrow({
      where: { id: membership.project.id },
      select: { changelogTone: true, changelogExampleIds: true },
    }));
  // The picked examples that are still published.
  const examples = style
    ? entries.filter((e) => e.publishedAt && style.changelogExampleIds.includes(e.id)).map((e) => e.number)
    : [];
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
                        {TAG_LABELS[tag]}
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
      {style && (
        <Card>
          <CardHeader>
            <CardTitle>Writing style</CardTitle>
            <CardDescription>
              Draft with AI writes like this. It takes facts only from the entry it drafts, never from the examples.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangelogStyleForm
              // A fresh form when the examples change underneath it (one unpublished, say), so stale picks don't count.
              key={examples.join(",")}
              projectSlug={slug}
              tone={style.changelogTone}
              examples={examples}
              published={entries.filter((e) => e.publishedAt).map(({ number, title }) => ({ number, title }))}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
