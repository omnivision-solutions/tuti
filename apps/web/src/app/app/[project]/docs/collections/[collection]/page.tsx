import { prisma } from "@tuti/db";
import { ChevronRightIcon, FolderIcon, GripVerticalIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ArticleColumns, articleRowDetails, CollectionHeader, DocsArticleRows, NewArticleRow } from "@/components/docs-article-rows";
import { DocsArticleOrder } from "@/components/docs-article-order";
import { NewCollectionButton } from "@/components/docs-tree";
import { timeAgo } from "@/lib/format";
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

  const latest = await prisma.articleRevision.findFirst({
    where: { article: { projectId, collectionId: collection.id, deletedAt: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true, codeChangeActionId: true, author: { select: { name: true } } },
  });
  const base = `/app/${slug}/docs`;

  return (
    <>
      <CollectionHeader
        projectSlug={slug}
        collection={{ slug: collection.slug, name: collection.name, description: collection.description, icon: collection.icon, knownIcon: collection.knownIcon }}
        hasChildren={inside.length > 0}
      />
      {rowDetails && <div className="docs-collection-summary flex gap-5.5 items-baseline text-muted-foreground text-[13.5px] [&_b]:[font:650_21px_var(--font-heading)] [&_b]:text-foreground [&_b]:mr-0.75 [&_small]:text-[13px] max-sm:gap-3 max-sm:flex-wrap max-sm:text-[13px] max-sm:[&_b]:text-[20px]"><span><b>{collection.articles.filter((a) => !rowDetails.detailsOf.get(a.slug)?.sample).reduce((sum, a) => sum + (rowDetails.stats.get(rowDetails.detailsOf.get(a.slug)?.id ?? "")?.views ?? 0), 0).toLocaleString("en")}</b> views</span><span><b>{collection.articles.filter((a) => !rowDetails.detailsOf.get(a.slug)?.sample).reduce((sum, a) => sum + (rowDetails.stats.get(rowDetails.detailsOf.get(a.slug)?.id ?? "")?.helpful ?? 0), 0)}</b> helpful votes</span><small>Last 30 days</small>{latest && <small className="ml-auto max-sm:basis-full">Last edited {timeAgo(latest.createdAt)} by {latest.author?.name ?? (latest.codeChangeActionId ? "Autopilot" : "a former teammate")}</small>}</div>}
      {collection.articles.length === 0 && inside.length === 0 ? (
        <EmptyState title="Nothing in this collection yet" description="Add an article or a collection to it, or move some here in the tree." />
      ) : (
        <Card role="region" aria-label={collection.name} className="docs-collection-table gap-0 py-0 border-0 rounded-none shadow-none ring-0 bg-transparent overflow-visible [&_>_ul]:p-[0_4px] [&_li]:min-h-17 [&_.docs-updated]:block max-sm:[&_.docs-updated]:hidden max-sm:[&_li]:min-h-22">
          <ArticleColumns />
          <DocsArticleOrder projectSlug={slug} collection={collection.slug} articles={collection.articles.map((article) => article.slug)}>
            {rowDetails && <DocsArticleRows projectSlug={slug} details={rowDetails} articles={collection.articles} reorder />}
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
            <NewArticleRow beside={<NewCollectionButton parent={collection.slug} />} href={`${base}/new?collection=${encodeURIComponent(collection.slug)}`} />
          </DocsArticleOrder>
        </Card>
      )}
      <p className="-mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"><GripVerticalIcon aria-hidden className="size-3.5" />Drag rows to reorder them; readers see this order.</p>
    </>
  );
}
