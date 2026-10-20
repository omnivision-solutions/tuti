import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { CollectionDialog, DeleteCollectionButton, RestoreDeletedButton } from "@/components/help";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/help";

/**
 * The team's help center: articles (drafts first, then latest edited), the collections they're
 * grouped in, and articles deleted lately (which can be restored).
 */
export default async function TeamHelpPage(props: PageProps<"/app/[project]/help">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [articles, collections, deleted] = await Promise.all([
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      select: { slug: true, title: true, publishedAt: true, listing: true, collection: { select: { name: true } } },
    }),
    prisma.collection.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true, _count: { select: { articles: { where: { deletedAt: null } } } } },
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
        title="Help center"
        description="Articles that answer your users' questions. Published ones show in your portal's help center."
        actions={
          <>
            <Link href={`/app/${slug}/help/insights`} className={buttonVariants({ variant: "outline" })}>
              Insights
            </Link>
            <Link href={`/app/${slug}/help/new`} className={buttonVariants()}>
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
                    <Link href={`/app/${slug}/help/${article.slug}`} className="hover:underline">
                      {article.title}
                    </Link>
                  }
                  badges={article.collection && <Badge variant="secondary">{article.collection.name}</Badge>}
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
      <Card>
        <CardHeader>
          <CardTitle>Collections</CardTitle>
          <CardDescription>Group articles by topic. Your help center lists them in this order.</CardDescription>
          <CardAction>
            <CollectionDialog projectSlug={slug} />
          </CardAction>
        </CardHeader>
        {collections.length > 0 && (
          <CardContent>
            <ItemList>
              {collections.map((collection) => (
                <ItemRow
                  key={collection.slug}
                  title={collection.name}
                  meta={`${collection._count.articles} ${collection._count.articles === 1 ? "article" : "articles"}`}
                  actions={
                    <>
                      <CollectionDialog projectSlug={slug} collection={collection} />
                      <DeleteCollectionButton projectSlug={slug} slug={collection.slug} name={collection.name} />
                    </>
                  }
                />
              ))}
            </ItemList>
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
