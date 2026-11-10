import { Fragment } from "react";
import { prisma } from "@tuti/db";
import { editsInChanges, DELETED_ARTICLE_DAYS } from "@tuti/jobs";
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
import { DocsPublishQueue } from "@/components/docs-publish-queue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VerifyAll } from "@/components/verify-all";
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
 * The team's docs at a glance (the tree beside it, as on every Docs page; "New tab" is under it): each tab, its collections (each a card with its articles, then the
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
  const waiting = await Promise.all(
    articles
      .filter((a) => !a.publishedAt || a.changes)
      .toSorted(
        (a, b) =>
          (rowDetails.savedAt.get(b.id) ?? b.updatedAt).getTime() -
          (rowDetails.savedAt.get(a.id) ?? a.updatedAt).getTime(),
      )
      .map(async (a) => ({
        slug: a.slug,
        title: a.title,
        published: Boolean(a.publishedAt),
        collection:
          docs.collections.find((c) =>
            c.articles.some((article) => article.slug === a.slug),
          )?.name ?? "Not in a collection",
        saved: timeAgo(rowDetails.savedAt.get(a.id) ?? a.updatedAt),
        savedAt: (a.changes?.updatedAt ?? a.updatedAt).toISOString(),
        edits: a.publishedAt
          ? []
          : (await editsInChanges(a.id)).map((edit) => edit.actionId),
      })),
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
        description={`${articles.length} articles in ${docs.collections.length} collections`}
        actions={
          <>
            <a
              href={`${portal}/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="docs-live-link"
            >
              <ExternalLinkIcon className="size-3.5" />
              <span>View on help center</span>
            </a>
            <AddContentMenu
              parent={null}
              tab={docs.tabs[0]?.slug}
              article={null}
            />
          </>
        }
      />
      <section aria-label="At a glance" className="docs-overview-stats">
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
      <div className="docs-overview-lists">
        <DocsPublishQueue projectSlug={slug} articles={waiting} />
        <section aria-labelledby="most-read-title" className="docs-most-read">
          <div className="docs-section-heading">
            <h2 id="most-read-title">
              Most read <small>{INSIGHTS_DAYS} days</small>
            </h2>
            <span className="docs-read-columns">
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
      <section className="docs-verify-all">
        <ShieldCheckIcon className="size-5 text-primary" />
        <div>
          <h2>Verify all articles against your code</h2>
          <p>Checks published articles; fixes wait for you in Autopilot.</p>
        </div>
        <VerifyAll
          projectSlug={slug}
          estimate={verifyAllEstimated}
          latest={latestVerify}
          unavailable={verifyUnavailable}
        />
      </section>
      <footer className="docs-live-footer">
        <span className="size-1.5 rounded-full bg-primary" />
        {published} articles live
        <a href={`${portal}/docs`} target="_blank" rel="noreferrer">
          View on help center <ExternalLinkIcon className="size-3" />
        </a>
      </footer>
      {deleted.length > 0 && (
        <>
          <Card
            id="recently-deleted"
            role="region"
            aria-labelledby="recently-deleted-title"
            className="scroll-mt-6"
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
