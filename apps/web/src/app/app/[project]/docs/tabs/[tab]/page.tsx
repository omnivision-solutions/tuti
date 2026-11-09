import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

import { AccessForm, DeleteTabButton, TabSettingsForm } from "@/components/docs";
import { articleRowDetails, TabContents } from "@/components/docs-article-rows";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { teamDocs, treeArticle } from "@/server/team-docs";

/** A tab's page in the app: what's in it (Content), who can read it (Access), and its name and landing page (Settings). */
export default async function TabPage(props: PageProps<"/app/[project]/docs/tabs/[tab]">) {
  const { project: slug, tab: tabSlug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, access] = await Promise.all([teamDocs(projectId), accessChoices(projectId)]);
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
  // The rows' details, only when there's something to list.
  const rowDetails = top.length > 0 || uncollected.length > 0 ? await articleRowDetails(projectId) : null;

  return (
    <>
      <PageHeader
        title={tab.name}
        description={first ? "Your help center's first tab: where readers land." : "A tab of your help center, with collections of its own."}
        // An article in no collection is on the first tab; on another, a new one starts in its first collection.
        actions={<AddContentMenu parent={null} tab={tab.slug} article={first ? null : (top[0]?.slug ?? false)} />}
        more={
          // The first is the docs' home: another goes first before it can go.
          (index > 0 || docs.tabs.length === 1) && <DeleteTabButton projectSlug={slug} tab={tab} movesTo={docs.tabs[index - 1]?.name ?? null} />
        }
      />
      <Tabs defaultValue="content">
        {/* Underlined, as the app's other page-level views (SubNav). */}
        <TabsList className="-mt-2 w-full justify-start gap-0 rounded-none bg-transparent p-0 shadow-[inset_0_-1px_0_var(--color-border)]">
          {["Content", "Access", "Settings"].map((name) => (
            <TabsTrigger
              key={name}
              value={name.toLowerCase()}
              className="rounded-none border-b-2 border-transparent px-2 py-2 first:pl-0 text-[0.875rem] data-active:border-primary data-active:bg-transparent data-active:shadow-none"
            >
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="content">
          {rowDetails ? (
            <TabContents projectSlug={slug} docs={docs} details={rowDetails} tab={tab.slug} uncollected={uncollected} />
          ) : (
            <EmptyState title="Nothing in this tab yet" description="Add a collection to it, or move one here in the tree." />
          )}
        </TabsContent>
        <TabsContent value="access">
          <Card>
            <CardContent>
              <AccessForm
                projectSlug={slug}
                slug={tab.slug}
                path={first ? "/docs" : `/docs/${tab.slug}`}
                access={access}
                above=""
                level={tab}
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
