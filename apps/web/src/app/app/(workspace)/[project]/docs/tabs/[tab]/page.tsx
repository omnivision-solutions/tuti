import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

import { AccessForm, DeleteTabButton, TabSettingsForm } from "@/components/docs";
import { articleRowDetails, TabContents } from "@/components/docs-article-rows";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { DocsPageHeader } from "@/components/docs-page-header";
import { FilterPills } from "@/components/filter-pills";
import { Card, CardContent } from "@/components/ui/card";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { teamDocs, treeArticle } from "@/server/team-docs";

/** A tab's page in the app: what's in it (Content), who can read it (Access), and its name and landing page (Settings). */
export default async function TabPage(props: PageProps<"/app/[project]/docs/tabs/[tab]">) {
  const [{ project: slug, tab: tabSlug }, { view }] = await Promise.all([props.params, props.searchParams]);
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
  const base = `/app/${slug}/docs/tabs/${tab.slug}`;
  const shown = view === "settings" || view === "access" ? view : "content";
  const inTab = docs.collections.filter((c) => c.tab === tab.slug);
  const top = inTab.filter((c) => c.parent === null);
  const uncollected = first ? docs.uncollected : [];
  // The rows' details, only when there's something to list.
  const rowDetails = top.length > 0 || uncollected.length > 0 ? await articleRowDetails(projectId) : null;

  return (
    <>
      <DocsPageHeader
        title={tab.name}
        // An article in no collection is on the first tab; on another, a new one starts in its first collection.
        actions={<AddContentMenu parent={null} tab={tab.slug} article={first ? null : (top[0]?.slug ?? false)} />}
        more={
          // The first is the docs' home: another goes first before it can go.
          (index > 0 || docs.tabs.length === 1) && <DeleteTabButton projectSlug={slug} tab={tab} movesTo={docs.tabs[index - 1]?.name ?? null} />
        }
        // `?view=settings` (the docs' home's "Tab settings") or `access` opens on that view.
        filters={<FilterPills label="Tab" items={["Content", "Access", "Settings"].map((name) => ({ title: name, href: name === "Content" ? base : `${base}?view=${name.toLowerCase()}` }))} />}
      />
      {/* The open view, named as its pill. */}
      <section aria-label={shown === "content" ? "Content" : shown === "access" ? "Access" : "Settings"}>
      {shown === "content" &&
        (rowDetails ? (
          <TabContents projectSlug={slug} docs={docs} details={rowDetails} tab={tab.slug} uncollected={uncollected} />
        ) : (
          <EmptyState title="Nothing in this tab yet" description="Add a collection to it, or move one here in the tree." />
        ))}
      {shown === "access" && (
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
      )}
      {shown === "settings" && (
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
      )}
      </section>
    </>
  );
}
