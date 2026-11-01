import { prisma } from "@tuti/db";
import { ChevronRightIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DeleteCollectionButton } from "@/components/docs";
import { DocsArticleRows } from "@/components/docs-article-rows";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { LucideIcon } from "@/components/icon-field";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { accessBadgeFor, contentsMeta, teamDocs } from "@/server/team-docs";

/** A collection's page in the app: what's in it (its articles as the docs' home lists them, then the collections in it); its settings are a page of their own. */
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
  const tab = docs.tabs.find((t) => t.slug === collection.tab);
  const parent = docs.collections.find((c) => c.id === collection.parentId);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {collection.knownIcon && collection.icon && <LucideIcon name={collection.icon} className="size-6 text-muted-foreground" />}
            {collection.name}
          </span>
        }
        meta={parent ? `Collection in ${docs.pathOf(parent.id)}` : tab ? `Collection in ${tab.name}` : "Collection"}
        actions={
          <>
            <Link href={`/app/${slug}/docs/collections/${collection.slug}/settings`} aria-label="Collection settings" className={buttonVariants({ variant: "ghost" })}>
              <SettingsIcon aria-hidden />
              Settings
            </Link>
            <AddContentMenu parent={collection.slug} article={collection.slug} />
          </>
        }
        more={<DeleteCollectionButton projectSlug={slug} slug={collection.slug} name={collection.name} hasChildren={inside.length > 0} />}
      />
      {collection.articles.length === 0 && inside.length === 0 ? (
        <EmptyState title="Nothing in this collection yet" description="Add an article or a collection to it, or move some here in the tree." />
      ) : (
        <Card role="region" aria-label={collection.name}>
          <CardContent>
            <ItemList>
              <DocsArticleRows projectSlug={slug} projectId={projectId} articles={collection.articles} />
              {inside.map((c) => (
                <ItemRow
                  key={c.slug}
                  leading={c.knownIcon && c.icon ? <LucideIcon name={c.icon} className="text-muted-foreground" /> : undefined}
                  title={
                    <Link href={`/app/${slug}/docs/collections/${c.slug}`} className="hover:underline">
                      {c.name}
                    </Link>
                  }
                  badges={badge(c) && <Badge variant="outline">{badge(c)}</Badge>}
                  meta={contentsMeta(c, docs)}
                  actions={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </>
  );
}
