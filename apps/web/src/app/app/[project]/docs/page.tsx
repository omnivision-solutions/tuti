import { Fragment } from "react";
import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import { ExternalLinkIcon, SettingsIcon } from "lucide-react";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RestoreDeletedButton } from "@/components/docs";
import { articleRowDetails, TabContents, WaitingToPublish } from "@/components/docs-article-rows";
import { INSIGHTS_DAYS } from "@/server/operations/docs-insights";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VerifyAll } from "@/components/verify-all";
import { timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";
import { latestVerifyAll, verifyAllEstimate, verifyAllUnavailable } from "@/server/operations/verify";
import { teamDocs } from "@/server/team-docs";

/**
 * The team's docs at a glance (the tree beside it, as on every Docs page; "New tab" is under it): each tab, its collections (each a card with its articles, then the
 * collections in it) and, on the first, the articles in none, in the order readers see them (drafts and
 * unpublished changes first); then articles deleted lately (which can be restored).
 */
export default async function TeamDocsPage(props: PageProps<"/app/[project]/docs">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, deleted, portal, rowDetails, verifyAllEstimated, latestVerify, verifyUnavailable] = await Promise.all([
    teamDocs(projectId),
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
    portalAddress(slug),
    articleRowDetails(projectId),
    verifyAllEstimate(projectId),
    latestVerifyAll(projectId),
    verifyAllUnavailable(projectId),
  ]);
  // At a glance: how many are out, read and found helpful (Reporting's window), and how many wait to be published.
  const articles = [...rowDetails.detailsOf.values()];
  const published = articles.filter((a) => a.publishedAt).length;
  const drafts = articles.length - published;
  const changed = articles.filter((a) => a.publishedAt && a.changes).length;
  const waiting = drafts + changed;
  // As Reporting counts them: the articles there now, sample ones left out.
  const counted = articles.filter((a) => !a.sample).map((a) => rowDetails.stats.get(a.id) ?? { views: 0, helpful: 0 });
  const views = counted.reduce((sum, s) => sum + s.views, 0);
  const helpful = counted.reduce((sum, s) => sum + s.helpful, 0);
  const base = `/app/${slug}/docs`;


  return (
    <>
      <PageHeader
        title="Docs"
        description="Your help center's articles, in collections."
        actions={
          <>
            <a href={`${portal}/docs`} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>
              <ExternalLinkIcon aria-hidden />
              View on portal
            </a>
            <AddContentMenu parent={null} tab={docs.tabs[0]?.slug} article={null} />
          </>
        }
        more={<VerifyAll projectSlug={slug} estimate={verifyAllEstimated} latest={latestVerify} unavailable={verifyUnavailable} />}
      />
      {/* On a phone the header's actions are its top bar's menu: the main one stays in sight here too. */}
      <AddContentMenu parent={null} tab={docs.tabs[0]?.slug} article={null} className="self-start topbar:hidden" />
      {/* At a glance, in one strip: what's out, how it's read (Reporting's window), and what waits to be published. */}
      <section aria-label="At a glance" className="grid grid-cols-2 overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-border sm:grid-cols-4">
        {[
          { value: published, label: `Published, of ${articles.length} ${articles.length === 1 ? "article" : "articles"}` },
          { value: views, label: `Views · ${INSIGHTS_DAYS} days`, href: `/app/${slug}/reporting/articles` },
          { value: helpful, label: `Helpful votes · ${INSIGHTS_DAYS} days`, href: `/app/${slug}/reporting/articles` },
          {
            value: waiting,
            label: "Waiting to publish",
            waits: waiting > 0,
          },
        ].map((stat, i) => {
          const body = (
            <>
              <span className="flex items-center gap-2 font-heading text-2xl font-semibold tabular-nums">
                {stat.value.toLocaleString("en")}
                {stat.waits && <span aria-hidden className="size-2 rounded-full bg-highlight-foreground" />}
              </span>
              <span className="text-xs text-muted-foreground">
                {stat.label}
              </span>
            </>
          );
          const cell = cn("flex flex-col gap-0.5 px-4 py-3", i % 2 === 1 && "border-l", i >= 2 && "border-t sm:border-t-0", i === 2 && "sm:border-l");
          return stat.href ? (
            <Link key={stat.label} href={stat.href} className={cn(cell, "transition-colors hover:bg-muted/50")}>
              {body}
            </Link>
          ) : (
            <div key={stat.label} className={cell}>
              {body}
            </div>
          );
        })}
      </section>
      {/* What's waiting for the team: what the tree beside it doesn't show. */}
      <WaitingToPublish projectSlug={slug} docs={docs} details={rowDetails} />
      {/* With tabs, each has a section (an empty one says so), so a new tab is there to open. */}
      {docs.tabs.length === 0 && docs.collections.length === 0 && docs.uncollected.length === 0 ? (
        <EmptyState title="No articles yet" description="Write the first one: how to get started is a good place to begin. Published articles show in your portal's docs." />
      ) : docs.tabs.length === 0 ? (
        <TabContents projectSlug={slug} docs={docs} details={rowDetails} tab={null} uncollected={docs.uncollected} />
      ) : (
        docs.tabs.map((tab, index) => (
          <section key={tab.slug} aria-labelledby={`tab-${tab.slug}`} className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id={`tab-${tab.slug}`} className="font-heading text-xl font-semibold">
                <Link href={`${base}/tabs/${tab.slug}`} className="hover:underline">
                  {tab.name}
                </Link>
              </h2>
              <Link href={`${base}/tabs/${tab.slug}?view=settings`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <SettingsIcon aria-hidden />
                Tab settings
              </Link>
            </div>
            {docs.collections.some((c) => c.parent === null && c.tab === tab.slug) || (index === 0 && docs.uncollected.length > 0) ? (
              <TabContents projectSlug={slug} docs={docs} details={rowDetails} tab={tab.slug} uncollected={index === 0 ? docs.uncollected : []} />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing in this tab yet.</p>
            )}
          </section>
        ))
      )}
      {deleted.length > 0 && (
        <>
          <Card id="recently-deleted" role="region" aria-labelledby="recently-deleted-title" className="scroll-mt-18">
            <CardHeader>
              <CardTitle id="recently-deleted-title">Recently deleted</CardTitle>
              <CardDescription>Deleted articles can be restored for {DELETED_ARTICLE_DAYS} days. They come back as drafts.</CardDescription>
            </CardHeader>
            <CardContent>
              <ItemList>
                {deleted.map((article) => (
                  <Fragment key={article.id}>
                    <ItemRow
                      title={article.title}
                      meta={`Deleted ${timeAgo(article.deletedAt!)}`}
                      actions={
                        article.revisions[0] && (
                          <RestoreDeletedButton projectSlug={slug} slug={article.slug} revision={article.revisions[0].id} title={article.title} />
                        )
                      }
                    />
                  </Fragment>
                ))}
              </ItemList>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
