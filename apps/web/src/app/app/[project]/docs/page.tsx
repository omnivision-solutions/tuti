import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { CollectionDialog, RestoreDeletedButton, TabDialog } from "@/components/docs";
import { DocsStructure } from "@/components/docs-structure";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { inTreeOrder, readingOrder } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";

const structureArticle = { slug: true, title: true, publishedAt: true } as const;
const structureView = (article: { slug: string; title: string; publishedAt: Date | null }) => ({
  slug: article.slug,
  title: article.title,
  published: article.publishedAt !== null,
});

/**
 * The team's docs: articles (drafts first, then latest edited), the collections they're
 * grouped in with their articles in the order readers see them (rearranged here), and articles
 * deleted lately (which can be restored).
 */
export default async function TeamDocsPage(props: PageProps<"/app/[project]/docs">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [articles, tabs, collections, uncollected, deleted] = await Promise.all([
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      select: {
        slug: true,
        title: true,
        publishedAt: true,
        listing: true,
        collection: { select: { name: true } },
        changes: { select: { articleId: true } },
      },
    }),
    prisma.docsTab.findMany({ where: { projectId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { slug: true, name: true } }),
    prisma.collection.findMany({
      where: { projectId },
      orderBy: readingOrder,
      select: {
        id: true,
        parentId: true,
        slug: true,
        name: true,
        description: true,
        parent: { select: { slug: true } },
        tab: { select: { slug: true } },
        groups: true,
        articles: { where: { deletedAt: null }, orderBy: [{ order: "asc" }, { title: "asc" }], select: structureArticle },
      },
    }),
    prisma.article.findMany({
      where: { projectId, deletedAt: null, collectionId: null },
      orderBy: [{ order: "asc" }, { title: "asc" }],
      select: structureArticle,
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
  ]);

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
        <Card>
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
      <Card role="region" aria-labelledby="docs-collections">
        <CardHeader>
          <CardTitle id="docs-collections">Collections</CardTitle>
          <CardDescription>
            Group articles by topic, with collections inside collections if you need them, and sections for tabs above them. Your docs
            list them in this order: drag them into place, or use the arrows.
          </CardDescription>
          <CardAction className="flex flex-wrap justify-end gap-2">
            <TabDialog projectSlug={slug} first={tabs.length === 0 && collections.length > 0} />
            <CollectionDialog
              projectSlug={slug}
              parents={inTreeOrder(collections)
                .filter((c) => c.parentId === null)
                .map((c) => ({ slug: c.slug, name: c.name }))}
              tabs={tabs}
            />
          </CardAction>
        </CardHeader>
        {(tabs.length > 0 || collections.length > 0 || uncollected.length > 0) && (
          <CardContent>
            <DocsStructure
              projectSlug={slug}
              tabs={tabs}
              collections={inTreeOrder(collections).map((c) => ({
                slug: c.slug,
                name: c.name,
                description: c.description,
                parent: c.parent?.slug ?? null,
                tab: c.tab?.slug ?? null,
                groups: c.groups,
                articles: c.articles.map(structureView),
              }))}
              uncollected={uncollected.map(structureView)}
            />
          </CardContent>
        )}
      </Card>
      {deleted.length > 0 && (
        <Card role="region" aria-labelledby="recently-deleted">
          <CardHeader>
            <CardTitle id="recently-deleted">Recently deleted</CardTitle>
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
