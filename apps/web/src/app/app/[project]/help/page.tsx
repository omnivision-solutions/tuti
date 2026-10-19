import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { CollectionDialog, DeleteCollectionButton } from "@/components/help";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { getMembership } from "@/server/membership";

/** The team's help center: articles (drafts first, then latest edited) and the collections they're grouped in. */
export default async function TeamHelpPage(props: PageProps<"/app/[project]/help">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [articles, collections] = await Promise.all([
    prisma.article.findMany({
      where: { projectId },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      select: { slug: true, title: true, publishedAt: true, collection: { select: { name: true } } },
    }),
    prisma.collection.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { slug: true, name: true, description: true, _count: { select: { articles: true } } },
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
                  meta={article.publishedAt ? `Published ${formatDate(article.publishedAt)}` : "Draft"}
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
    </>
  );
}
