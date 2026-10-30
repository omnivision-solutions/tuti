import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import { ChevronRightIcon, ExternalLinkIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RestoreDeletedButton, TabDialog } from "@/components/docs";
import { AddContentMenu, DocsFilter, DocsMatch, DocsNoMatch } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { LucideIcon } from "@/components/icon-field";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { levelSelect } from "@/lib/reader-groups";
import { portalAddress } from "@/server/custom-domains";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";
import { accessBadgeFor, contentsMeta, type TeamDocs, teamDocs } from "@/server/team-docs";

/**
 * The team's docs at a glance, the whole width (no tree beside it; a tab's, a collection's or an
 * article's page has it): each tab, its collections (each a card with its articles, then the
 * collections in it) and, on the first, the articles in none, in the order readers see them; then
 * articles deleted lately (which can be restored).
 */
export default async function TeamDocsPage(props: PageProps<"/app/[project]/docs">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, details, deleted, access, portal] = await Promise.all([
    teamDocs(projectId),
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      select: { slug: true, publishedAt: true, listing: true, ...levelSelect, changes: { select: { articleId: true } } },
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
    accessChoices(projectId),
    portalAddress(slug),
  ]);
  // Rows say who can read them when it isn't inherit ("Signed-in", "Enterprise, Pro").
  const badge = accessBadgeFor(access);
  const detailsOf = new Map(details.map((d) => [d.slug, d]));
  const base = `/app/${slug}/docs`;

  /** Collection `c`'s name, and those of everything in it: what "Filter by title" looks for to show it. */
  const textsOf = (c: TeamDocs["collections"][number]): string[] => [
    c.name,
    ...c.articles.map((a) => a.title),
    ...docs.collections.filter((other) => other.parentId === c.id).flatMap(textsOf),
  ];

  const articleRows = (articles: { slug: string; title: string }[]) =>
    articles.map(({ slug: articleSlug, title }) => {
      const article = detailsOf.get(articleSlug);
      return (
        <DocsMatch key={articleSlug} texts={[title]}>
          <ItemRow
            leading={<FileTextIcon aria-hidden className="size-4 text-muted-foreground" />}
            title={
              <Link href={`${base}/${articleSlug}`} className="hover:underline">
                {title}
              </Link>
            }
            badges={
              article && (
                <>
                  {badge(article) && <Badge variant="outline">{badge(article)}</Badge>}
                  {article.changes && <Badge variant="highlight">Unpublished changes</Badge>}
                </>
              )
            }
            meta={
              article?.publishedAt
                ? `Published ${formatDate(article.publishedAt)}${article.listing === "EVERYWHERE" ? "" : ` · ${LISTING_LABELS[article.listing.toLowerCase() as Listing]}`}`
                : "Draft"
            }
          />
        </DocsMatch>
      );
    });

  /** A top-level collection's card: its articles, then the collections in it (each opens its page). */
  const collectionCard = (c: TeamDocs["collections"][number]) => {
    const inside = docs.collections.filter((other) => other.parentId === c.id);
    return (
      <DocsMatch key={c.slug} texts={textsOf(c)}>
        <Card role="region" aria-label={c.name}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {c.knownIcon && c.icon && <LucideIcon name={c.icon} className="text-muted-foreground" />}
              <Link href={`${base}/collections/${c.slug}`} className="hover:underline">
                {c.name}
              </Link>
              {badge(c) && <Badge variant="outline">{badge(c)}</Badge>}
            </CardTitle>
            <CardDescription>{contentsMeta(c, docs)}</CardDescription>
          </CardHeader>
          {(c.articles.length > 0 || inside.length > 0) && (
            <CardContent>
              <ItemList>
                {articleRows(c.articles)}
                {inside.map((child) => (
                  <DocsMatch key={child.slug} texts={textsOf(child)}>
                    <ItemRow
                      leading={child.knownIcon && child.icon ? <LucideIcon name={child.icon} className="text-muted-foreground" /> : undefined}
                      title={
                        <Link href={`${base}/collections/${child.slug}`} className="hover:underline">
                          {child.name}
                        </Link>
                      }
                      badges={badge(child) && <Badge variant="outline">{badge(child)}</Badge>}
                      meta={contentsMeta(child, docs)}
                      actions={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
                    />
                  </DocsMatch>
                ))}
              </ItemList>
            </CardContent>
          )}
        </Card>
      </DocsMatch>
    );
  };
  const uncollectedCard = docs.uncollected.length > 0 && (
    <DocsMatch texts={docs.uncollected.map((a) => a.title)}>
      <Card role="region" aria-label="Not in a collection">
        <CardHeader>
          <CardTitle>Not in a collection</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemList>{articleRows(docs.uncollected)}</ItemList>
        </CardContent>
      </Card>
    </DocsMatch>
  );
  const top = (tab: string | null) => docs.collections.filter((c) => c.parent === null && c.tab === tab);

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            Docs
            <a
              href={`${portal}/docs`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open your portal's docs"
              title="Open your portal's docs"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLinkIcon aria-hidden className="size-4" />
            </a>
          </span>
        }
        actions={
          <>
            <DocsFilter />
            <Link href={`${base}/insights`} className={buttonVariants({ variant: "outline" })}>
              Insights
            </Link>
            <AddContentMenu parent={null} tab={docs.tabs[0]?.slug} article={null} />
          </>
        }
      />
      {/* With tabs, each has a section (an empty one says so), so a new tab is there to open. */}
      {docs.tabs.length === 0 && docs.collections.length === 0 && docs.uncollected.length === 0 ? (
        <EmptyState title="No articles yet" description="Write the first one: how to get started is a good place to begin. Published articles show in your portal's docs." />
      ) : docs.tabs.length === 0 ? (
        <>
          {top(null).map(collectionCard)}
          {uncollectedCard}
        </>
      ) : (
        docs.tabs.map((tab, index) => (
          <DocsMatch key={tab.slug} texts={[tab.name, ...top(tab.slug).flatMap(textsOf), ...(index === 0 ? docs.uncollected.map((a) => a.title) : [])]}>
            <section aria-labelledby={`tab-${tab.slug}`} className="flex flex-col gap-4">
              <h2 id={`tab-${tab.slug}`} className="font-heading text-lg font-semibold">
                <Link href={`${base}/tabs/${tab.slug}`} className="hover:underline">
                  {tab.name}
                </Link>
              </h2>
              {top(tab.slug).map(collectionCard)}
              {index === 0 && uncollectedCard}
              {top(tab.slug).length === 0 && !(index === 0 && uncollectedCard) && <p className="text-sm text-muted-foreground">Nothing in this tab yet.</p>}
            </section>
          </DocsMatch>
        ))
      )}
      <DocsNoMatch texts={[...docs.tabs.map((tab) => tab.name), ...docs.collections.map((c) => c.name), ...docs.collections.flatMap((c) => c.articles.map((a) => a.title)), ...docs.uncollected.map((a) => a.title), ...deleted.map((a) => a.title)]} />
      <div>
        <TabDialog projectSlug={slug} first={docs.tabs.length === 0 && docs.collections.length > 0} />
      </div>
      {deleted.length > 0 && (
        <DocsMatch texts={deleted.map((article) => article.title)}>
          <Card id="recently-deleted" role="region" aria-labelledby="recently-deleted-title" className="scroll-mt-18">
            <CardHeader>
              <CardTitle id="recently-deleted-title">Recently deleted</CardTitle>
              <CardDescription>Deleted articles can be restored for {DELETED_ARTICLE_DAYS} days. They come back as drafts.</CardDescription>
            </CardHeader>
            <CardContent>
              <ItemList>
                {deleted.map((article) => (
                  <DocsMatch key={article.id} texts={[article.title]}>
                    <ItemRow
                      title={article.title}
                      meta={`Deleted ${timeAgo(article.deletedAt!)}`}
                      actions={
                        article.revisions[0] && (
                          <RestoreDeletedButton projectSlug={slug} slug={article.slug} revision={article.revisions[0].id} title={article.title} />
                        )
                      }
                    />
                  </DocsMatch>
                ))}
              </ItemList>
            </CardContent>
          </Card>
        </DocsMatch>
      )}
    </>
  );
}
