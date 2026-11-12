import { cn } from "cn";
import { Fragment } from "react";
import { prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS } from "@tuti/jobs";
import { ExternalLinkIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RestoreDeletedButton } from "@/components/docs";
import { articleRowDetails } from "@/components/docs-article-rows";
import { INSIGHTS_DAYS } from "@/server/operations/docs-insights";
import { AddContentMenu } from "@/components/docs-tree";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { DocsPageHeader } from "@/components/docs-page-header";
import { buttonVariants } from "@/components/ui/button";
import { DocsPublishQueue } from "@/components/docs-publish-queue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VerifyAll } from "@/components/verify-all";
import { plural } from "@/lib/autopilot-words";
import { timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";
import {
  latestVerifyAll,
  verifyAllEstimate,
  verifyAllUnavailable,
} from "@/server/operations/verify";
import { teamDocs } from "@/server/team-docs";

/**
 * The team's docs at a glance (the tree beside it, as on every Docs page): each tab, its collections (each a card with its articles, then the
 * collections in it) and, on the first, the articles in none, in the order readers see them (drafts and
 * unpublished changes first); then articles deleted lately (which can be restored).
 */
export default async function TeamDocsPage(
  props: PageProps<"/app/[project]/docs">,
) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [
    docs,
    deleted,
    portal,
    rowDetails,
    verifyAllEstimated,
    latestVerify,
    verifyUnavailable,
  ] = await Promise.all([
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
        revisions: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true },
        },
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
  // One query for the whole queue. Waiting edits must be reviewed before their saved text can go live.
  const edits = await prisma.articleRevision.findMany({
    where: { articleId: { in: articles.filter((a) => !a.publishedAt || a.changes).map((a) => a.id) }, codeChangeAction: { status: { in: ["PENDING", "STALE", "SCHEDULED"] } } },
    select: { articleId: true }, distinct: ["articleId"],
  });
  const needsReview = new Set(edits.map((edit) => edit.articleId));
  const waiting = (
    articles
      .filter((a) => !a.publishedAt || a.changes)
      .toSorted(
        (a, b) =>
          (rowDetails.savedAt.get(b.id) ?? b.updatedAt).getTime() -
          (rowDetails.savedAt.get(a.id) ?? a.updatedAt).getTime(),
      )
      .map((a) => ({
        slug: a.slug,
        title: a.title,
        published: Boolean(a.publishedAt),
        collection:
          docs.collections.find((c) =>
            c.articles.some((article) => article.slug === a.slug),
          )?.name ?? "Not in a collection",
        saved: timeAgo(rowDetails.savedAt.get(a.id) ?? a.updatedAt),
        savedAt: (a.changes?.updatedAt ?? a.updatedAt).toISOString(),
        reviewRequired: needsReview.has(a.id),
        revision: a.revisions[0]?.id ?? null,
      }))
  );
  const mostRead = articles
    .filter((a) => a.publishedAt && !a.sample)
    .toSorted(
      (a, b) =>
        (rowDetails.stats.get(b.id)?.views ?? 0) -
        (rowDetails.stats.get(a.id)?.views ?? 0),
    )
    .slice(0, 4);
  // As Reporting counts them: the articles there now, sample ones left out.
  const counted = articles
    .filter((a) => !a.sample)
    .map((a) => rowDetails.stats.get(a.id) ?? { views: 0, helpful: 0 });
  const views = counted.reduce((sum, s) => sum + s.views, 0);
  const helpful = counted.reduce((sum, s) => sum + s.helpful, 0);

  return (
    <>
      <DocsPageHeader
        title="Overview"
        description={`${plural(articles.length, "article")} in ${plural(docs.collections.length, "collection")}`}
        actions={
          <>
            <a
              href={`${portal}/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", className: "docs-live-link" })}
            >
              <ExternalLinkIcon />
              <span className="@max-[48rem]/app:sr-only">View on help center</span>
            </a>
            <AddContentMenu
              parent={null}
              tab={docs.tabs[0]?.slug}
              article={null}
            />
          </>
        }
      />
      <section aria-label="At a glance" className={cn(
        "docs-overview-stats flex gap-16.5 p-[4px_0_28px] border-b border-border [&_>_div]:flex [&_>_div]:flex-col [&_>_div]:gap-0.5",
        "[&_>_a]:flex [&_>_a]:flex-col [&_>_a]:gap-0.5 [&_b]:font-heading [&_b]:text-[30px] [&_b]:leading-[1.2] [&_b]:font-[650]",
        "[&_b]:tracking-[-0.03em] [&_span]:text-muted-foreground [&_span]:text-[13px] [&_small]:text-muted-foreground [&_small]:text-[13px]",
        "[&_>_small]:ml-auto [&_>_small]:[align-self:end] max-sm:gap-8 max-sm:pb-5.5 max-sm:flex-wrap max-sm:gap-x-8 max-sm:gap-y-3.5",
        "max-sm:[&_b]:text-[27px] max-sm:[&_>_small]:basis-full max-sm:[&_>_small]:text-xs max-sm:[&_>_small]:ml-0",
      )}>
        {[
          { value: published, label: "Live articles" },
          {
            value: views,
            label: "Views",
            href: `/app/${slug}/reporting/articles`,
          },
          {
            value: helpful,
            label: "Helpful votes",
            href: `/app/${slug}/reporting/articles`,
          },
        ].map((stat) => {
          const content = (
            <>
              <b>{stat.value.toLocaleString("en")}</b>
              <span>{stat.label}</span>
            </>
          );
          return stat.href ? (
            <Link key={stat.label} href={stat.href}>
              {content}
            </Link>
          ) : (
            <div key={stat.label}>{content}</div>
          );
        })}
        <small>Last {INSIGHTS_DAYS} days</small>
      </section>
      <div className={cn(
        "docs-overview-lists grid grid-cols-2 gap-9 min-h-77.5 [&_li]:flex [&_li]:gap-3 [&_li]:items-center [&_li]:p-[13px_0] [&_li]:min-h-16.5",
        "[&_li_>_div]:min-w-0 [&_li_>_div]:flex-1 [&_li_>_div]:flex [&_li_>_div]:flex-col [&_li_>_div]:gap-0.75 [&_li_>_div_>_a]:text-[15px]",
        "[&_li_>_div_>_a]:[font-weight:550] [&_li_>_div_>_a]:leading-[1.35] [&_li_small]:text-muted-foreground [&_li_small]:text-[13px]",
        "max-xl:gap-6 max-sm:grid-cols-1 max-sm:gap-7.5 max-sm:min-h-0",
      )}>
        <DocsPublishQueue projectSlug={slug} articles={waiting} />
        <section aria-labelledby="most-read-title" className="docs-most-read [&_li_>_span]:w-14.5 [&_li_>_span]:shrink-0 [&_li_>_span]:text-right [&_li_>_span]:tabular-nums [&_li_>_span]:text-[14px] [&_li_>_span:last-child]:text-muted-foreground [&_.docs-section-heading]:mb-8.75 [&_li]:min-h-18.25 max-sm:[&_.docs-section-heading]:mb-2">
          <div className="docs-section-heading flex items-center justify-between gap-2.5 min-h-8 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:[font:600_17px/1.35_var(--font-sans)] [&_h2_small]:text-[13px] [&_h2_small]:text-muted-foreground [&_h2_small]:font-normal max-sm:[&_h2]:text-[16px]">
            <h2 id="most-read-title">
              Most read <small>{INSIGHTS_DAYS} days</small>
            </h2>
            <span className="docs-read-columns [&_>_span]:w-14.5 [&_>_span]:shrink-0 [&_>_span]:text-right [&_>_span]:tabular-nums [&_>_span]:text-xs flex gap-3 text-muted-foreground">
              <span>Views</span>
              <span>Helpful</span>
            </span>
          </div>
          <ul>
            {mostRead.map((article) => (
              <li key={article.slug}>
                <div>
                  <Link href={`/app/${slug}/docs/${article.slug}`}>
                    {article.title}
                  </Link>
                  <small>
                    {docs.collections.find((c) =>
                      c.articles.some((a) => a.slug === article.slug),
                    )?.name ?? "Not in a collection"}
                  </small>
                </div>
                <span>
                  {(
                    rowDetails.stats.get(article.id)?.views ?? 0
                  ).toLocaleString("en")}
                </span>
                <span>{rowDetails.stats.get(article.id)?.helpful ?? 0}</span>
              </li>
            ))}
          </ul>
          {mostRead.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              Published articles and their views appear here.
            </p>
          )}
        </section>
      </div>
      {articles.length === 0 && (
        <EmptyState
          title="No articles yet"
          description="Write the first one: how to get started is a good place to begin. Published articles show in your help center."
        />
      )}
      <section className="docs-verify-all flex gap-3.5 items-center pt-6 [border-top:1px_solid_var(--border)] [&_>_div]:flex-1 [&_h2]:[font:600_15px_var(--font-sans)] [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-0.75 max-sm:items-start max-sm:flex-wrap max-sm:[&_>_div]:min-w-60 max-sm:[&_>_button]:ml-8.5">
        <ShieldCheckIcon className="size-5 text-primary" />
        <div>
          <h2>Verify all articles against your code</h2>
          <p>Checks {plural(published, "published article")}; fixes wait for you in Autopilot.</p>
        </div>
        <VerifyAll
          projectSlug={slug}
          estimate={verifyAllEstimated}
          latest={latestVerify}
          unavailable={verifyUnavailable}
        />
      </section>
      <footer className="docs-live-footer flex items-center gap-1.75 text-[13px] text-muted-foreground [&_a]:flex [&_a]:items-center [&_a]:gap-1.25 [&_a]:ml-auto max-sm:flex-wrap max-sm:[&_a]:ml-0 max-sm:[&_a]:basis-full">
        <span className="size-1.5 rounded-full bg-primary" />
        {plural(published, "article")} live{docs.tabs[0] && ` · ${docs.tabs[0].name} tab`}
        <a href={`${portal}/docs`} target="_blank" rel="noreferrer">
          {portal.replace(/^https?:\/\//, "")}/docs <ExternalLinkIcon className="size-3" />
        </a>
      </footer>
      {deleted.length > 0 && (
        <>
          <Card
            id="recently-deleted"
            role="region"
            aria-labelledby="recently-deleted-title"
            className="hidden scroll-mt-6 target:flex"
          >
            <CardHeader>
              <CardTitle id="recently-deleted-title">
                Recently deleted
              </CardTitle>
              <CardDescription>
                Deleted articles can be restored for {DELETED_ARTICLE_DAYS}{" "}
                days. They come back as drafts.
              </CardDescription>
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
                          <RestoreDeletedButton
                            projectSlug={slug}
                            slug={article.slug}
                            revision={article.revisions[0].id}
                            title={article.title}
                          />
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
