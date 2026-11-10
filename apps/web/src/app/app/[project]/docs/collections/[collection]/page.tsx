import { prisma } from "@tuti/db";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ArticleColumns, articleRowDetails, CollectionHeader, DocsArticleRows, NewArticleRow } from "@/components/docs-article-rows";
import { EmptyState } from "@/components/empty-state";
import { LucideIcon } from "@/components/icon-field";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { accessBadgeFor, contentsMeta, teamDocs } from "@/server/team-docs";

/** A collection's page in the app: what's in it (its articles as the docs' home lists them, then the collections in it); its Settings are its other tab. */
export default async function CollectionPage(props: PageProps<"/app/[project]/docs/collections/[collection]">) {
  const { project: slug, collection: collectionSlug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, access] = await Promise.all([teamDocs(projectId), accessChoices(projectId)]);
  const badge = accessBadgeFor(access);
  const collection = docs.collections.find((c) => c.slug === collectionSlug);
  if (!collection) {
    // Renamed: its page now. Deleted: the docs.
    const renamed = await prisma.docsRedirect.findFirst({ where: { projectId, slug: collectionSlug }, select: { collection: { select: { slug: true } } } });
    redirect(renamed?.collection ? `/app/${slug}/docs/collections/${renamed.collection.slug}` : `/app/${slug}/docs`);
  }
  const inside = docs.collections.filter((c) => c.parentId === collection.id);
  // The article rows' details, only when there are articles to list.
  const rowDetails = collection.articles.length > 0 ? await articleRowDetails(projectId) : null;

  const base = `/app/${slug}/docs`;

  return (
    <>
      <CollectionHeader
        projectSlug={slug}
        collection={{ slug: collection.slug, name: collection.name, description: collection.description, icon: collection.icon, knownIcon: collection.knownIcon }}
        hasChildren={inside.length > 0}
      />
      {rowDetails && <div className="docs-collection-summary"><span><b>{collection.articles.reduce((sum, a) => sum + (rowDetails.stats.get(rowDetails.detailsOf.get(a.slug)?.id ?? "")?.views ?? 0), 0).toLocaleString("en")}</b> views</span><span><b>{collection.articles.reduce((sum, a) => sum + (rowDetails.stats.get(rowDetails.detailsOf.get(a.slug)?.id ?? "")?.helpful ?? 0), 0)}</b> helpful votes</span><small>Last 30 days</small></div>}
      {collection.articles.length === 0 && inside.length === 0 ? (
        <EmptyState title="Nothing in this collection yet" description="Add an article or a collection to it, or move some here in the tree." />
      ) : (
        <Card role="region" aria-label={collection.name} className="docs-collection-table gap-0 py-0">
          <ArticleColumns />
          <ul className="flex flex-col divide-y px-5">
            {rowDetails && <DocsArticleRows projectSlug={slug} details={rowDetails} articles={collection.articles} />}
            {inside.map((c) => (
              <li key={c.slug} className="flex items-center gap-3 py-2.5">
                {c.knownIcon && c.icon ? <LucideIcon name={c.icon} className="size-4 text-muted-foreground" /> : <FolderIcon aria-hidden className="size-4 text-muted-foreground" />}
                <Link href={`${base}/collections/${c.slug}`} className="min-w-0 flex-1 text-sm font-medium break-words hover:underline">
                  {c.name}
                </Link>
                {badge(c) && <Badge variant="outline">{badge(c)}</Badge>}
                <span className="text-xs text-muted-foreground">{contentsMeta(c, docs)}</span>
                <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
              </li>
            ))}
            <NewArticleRow href={`${base}/new?collection=${encodeURIComponent(collection.slug)}`} />
          </ul>
        </Card>
      )}
    </>
  );
}
