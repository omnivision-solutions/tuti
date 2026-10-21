import { prisma } from "@tuti/db";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AccessForm, DeleteTabButton, TabSettingsForm } from "@/components/docs";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { LucideIcon } from "@/components/icon-field";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { accessBadgeFor, contentsMeta, teamDocs, treeArticle } from "@/server/team-docs";

/** A tab's page in the app: what's in it (Content), who can read it (Access), and its name and landing page (Settings). */
export default async function TabPage(props: PageProps<"/app/[project]/docs/tabs/[tab]">) {
  const { project: slug, tab: tabSlug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, access] = await Promise.all([teamDocs(projectId), accessChoices(projectId)]);
  const badge = accessBadgeFor(access);
  const index = docs.tabs.findIndex((t) => t.slug === tabSlug);
  const tab = docs.tabs[index];
  if (!tab) {
    // Renamed (here too, after saving its Settings): its page now. Deleted: the docs.
    const renamed = await prisma.docsRedirect.findFirst({ where: { projectId, slug: tabSlug }, select: { tab: { select: { slug: true } } } });
    redirect(renamed?.tab ? `/app/${slug}/docs/tabs/${renamed.tab.slug}` : `/app/${slug}/docs`);
  }
  const first = index === 0;
  const inTab = docs.collections.filter((c) => c.tab === tab.slug);
  const top = inTab.filter((c) => c.parent === null);
  const uncollected = first ? docs.uncollected : [];
  const count = top.length;

  return (
    <>
      <PageHeader
        title={tab.name}
        description={`Tab · ${count} ${count === 1 ? "collection" : "collections"}`}
        actions={
          // The first is the docs' home: another goes first before it can go.
          (index > 0 || docs.tabs.length === 1) && <DeleteTabButton projectSlug={slug} tab={tab} movesTo={docs.tabs[index - 1]?.name ?? null} />
        }
      />
      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="content">
          <div className="flex justify-end">
            {/* An article in no collection is on the first tab; on another, a new one starts in its first collection. */}
            <AddContentMenu parent={null} tab={tab.slug} article={first ? null : (top[0]?.slug ?? false)} />
          </div>
          {top.length === 0 && uncollected.length === 0 ? (
            <EmptyState title="Nothing in this tab yet" description="Add a collection to it, or move one here in the tree." />
          ) : (
            <Card>
              <CardContent>
                <ItemList>
                  {top.map((c) => (
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
                  {uncollected.map(treeArticle).map((article) => (
                    <ItemRow
                      key={article.slug}
                      leading={<FileTextIcon aria-hidden className="size-4 text-muted-foreground" />}
                      title={
                        <Link href={`/app/${slug}/docs/${article.slug}`} className="hover:underline">
                          {article.title}
                        </Link>
                      }
                      meta={article.published ? "Article in no collection" : "Draft · in no collection"}
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
                kind="tab"
                slug={tab.slug}
                groups={access.groups}
                inherit={{ label: "Inherit", description: access.inherits[""]! }}
                access={tab.access}
                defaultGroups={tab.groups}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="settings">
          <Card>
            <CardContent>
              <TabSettingsForm
                projectSlug={slug}
                home={first}
                tab={{
                  ...tab,
                  pages: {
                    collections: inTab.map((c) => ({ slug: c.slug, name: c.name })),
                    articles: [...inTab.flatMap((c) => c.articles), ...uncollected].map(treeArticle),
                  },
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
