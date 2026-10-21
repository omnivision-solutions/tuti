import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { RestoreDeletedButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { levelSelect } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";
import { accessBadgeFor } from "@/server/team-docs";

/**
 * The team's docs: articles (drafts first, then latest edited) and articles deleted lately (which
 * can be restored). The tree beside it (the layout's) arranges them in tabs and collections.
 */
export default async function TeamDocsPage(props: PageProps<"/app/[project]/docs">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [articles, deleted, access] = await Promise.all([
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      select: {
        slug: true,
        title: true,
        publishedAt: true,
        listing: true,
        ...levelSelect,
        collection: { select: { name: true } },
        changes: { select: { articleId: true } },
      },
    }),
    prisma.article.findMany({
      where: { projectId, deletedAt: { gte: restorableSince() } },
      orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        slug: true,
        title: true,
        deletedAt: true,
        // Its newest version, which tells the restore which article it is (another may have had the slug).
        revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } },
      },
    }),
    accessChoices(projectId),
  ]);
  // Rows say who can read them when it isn't inherit ("Signed-in", "Enterprise, Pro").
  const badge = accessBadgeFor(access);

  return (
    <>
      <PageHeader
        title="Docs"
        description="Articles that answer your users' questions. Published ones show in your portal's docs."
        actions={
          <>
            <Link href={`/app/${slug}/docs/insights`} className={buttonVariants({ variant: "outline" })}>
              Insights
            </Link>
            <Link href={`/app/${slug}/docs/new`} className={buttonVariants()}>
              New article
            </Link>
          </>
        }
      />
      {articles.length === 0 ? (
        <EmptyState title="No articles yet" description="Write the first one: how to get started is a good place to begin." />
      ) : (
        <Card role="region" aria-label="Articles">
          <CardContent>
            <ItemList>
              {articles.map((article) => (
                <ItemRow
                  key={article.slug}
                  title={
                    <Link href={`/app/${slug}/docs/${article.slug}`} className="hover:underline">
                      {article.title}
                    </Link>
                  }
                  badges={
                    <>
                      {article.collection && <Badge variant="secondary">{article.collection.name}</Badge>}
                      {badge(article) && <Badge variant="outline">{badge(article)}</Badge>}
                      {article.changes && <Badge variant="highlight">Unpublished changes</Badge>}
                    </>
                  }
                  meta={
                    article.publishedAt
                      ? `Published ${formatDate(article.publishedAt)}${article.listing === "EVERYWHERE" ? "" : ` · ${LISTING_LABELS[article.listing.toLowerCase() as Listing]}`}`
                      : "Draft"
                  }
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
      {deleted.length > 0 && (
        <Card id="recently-deleted" role="region" aria-labelledby="recently-deleted-title" className="scroll-mt-6">
          <CardHeader>
            <CardTitle id="recently-deleted-title">Recently deleted</CardTitle>
            <CardDescription>Deleted articles can be restored for {DELETED_ARTICLE_DAYS} days. They come back as drafts.</CardDescription>
          </CardHeader>
          <CardContent>
            <ItemList>
              {deleted.map((article) => (
                <ItemRow
                  key={article.id}
                  title={article.title}
                  meta={`Deleted ${timeAgo(article.deletedAt!)}`}
                  actions={
                    article.revisions[0] && (
                      <RestoreDeletedButton projectSlug={slug} slug={article.slug} revision={article.revisions[0].id} title={article.title} />
                    )
                  }
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </>
  );
}
