import { prisma } from "@tuti/db";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AccessForm, CollectionSettingsForm, DeleteCollectionButton } from "@/components/docs";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { LucideIcon } from "@/components/icon-field";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ancestry, height, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { fromReadAccess } from "@/lib/read-access";
import { claimsOf } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { accessBadgeFor, contentsMeta, teamDocs, treeArticle } from "@/server/team-docs";

/** A collection's page in the app: what's in it (Content), who can read it (Access), and its name, icon and place (Settings). */
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
    // Renamed (here too, after saving its Settings): its page now. Deleted: the docs.
    const renamed = await prisma.docsRedirect.findFirst({ where: { projectId, slug: collectionSlug }, select: { collection: { select: { slug: true } } } });
    redirect(renamed?.collection ? `/app/${slug}/docs/collections/${renamed.collection.slug}` : `/app/${slug}/docs`);
  }
  const inside = docs.collections.filter((c) => c.parentId === collection.id);
  const tab = docs.tabs.find((t) => t.slug === collection.tab);
  const parent = docs.collections.find((c) => c.id === collection.parentId);
  // Where it can go: not in itself or one inside it, and no deeper than collections go with the ones in it.
  const levels = height(docs.collections, collection.id);
  const parents = docs.collections
    .filter((c) => c.depth + levels <= MAX_COLLECTION_DEPTH && !ancestry(docs.collections, c.id).some((up) => up.id === collection.id))
    .map((c) => ({ slug: c.slug, name: docs.pathOf(c.id) }));
  const above = collection.parent ?? collection.tab;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {collection.knownIcon && collection.icon && <LucideIcon name={collection.icon} className="size-6 text-muted-foreground" />}
            {collection.name}
          </span>
        }
        description={parent ? `Collection in ${docs.pathOf(parent.id)}` : tab ? `Collection in ${tab.name}` : "Collection"}
        actions={<DeleteCollectionButton projectSlug={slug} slug={collection.slug} name={collection.name} hasChildren={inside.length > 0} />}
      />
      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="content">
          <div className="flex justify-end">
            <AddContentMenu parent={collection.slug} article={collection.slug} />
          </div>
          {collection.articles.length === 0 && inside.length === 0 ? (
            <EmptyState title="Nothing in this collection yet" description="Add an article or a collection to it, or move some here in the tree." />
          ) : (
            <Card>
              <CardContent>
                <ItemList>
                  {collection.articles.map(treeArticle).map((article) => (
                    <ItemRow
                      key={article.slug}
                      leading={<FileTextIcon aria-hidden className="size-4 text-muted-foreground" />}
                      title={
                        <Link href={`/app/${slug}/docs/${article.slug}`} className="hover:underline">
                          {article.title}
                        </Link>
                      }
                      meta={article.published ? "Article" : "Draft"}
                      actions={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
                    />
                  ))}
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
        </TabsContent>
        <TabsContent value="access">
          <Card>
            <CardContent>
              <AccessForm
                projectSlug={slug}
                kind="collection"
                slug={collection.slug}
                groups={access.groups}
                inherit={{ label: "Inherit", description: access.inherits[above ?? ""] ?? access.inherits[""]! }}
                access={fromReadAccess(collection.access)}
                defaultGroups={claimsOf(collection)}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings">
          <Card>
            <CardContent>
              <CollectionSettingsForm
                projectSlug={slug}
                collection={{
                  slug: collection.slug,
                  name: collection.name,
                  description: collection.description,
                  parent: collection.parent,
                  icon: collection.icon,
                  knownIcon: collection.knownIcon,
                }}
                parents={parents}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
