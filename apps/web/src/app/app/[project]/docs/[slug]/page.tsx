import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleSettings } from "@/components/article-settings";
import { previewUrl } from "@/lib/portal-base";
import { ArticleActions, ArticleChanges, ArticleForm } from "@/components/docs";
import { ArticleDiff } from "@/components/article-diff";
import { ArticleHistory } from "@/components/article-history";
import { HistorySheet } from "@/components/history-sheet";
import { DocsFilter } from "@/components/docs-tree";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import { fromNoAccess, fromReadAccess } from "@/lib/read-access";
import { claimsOf, levelSelect } from "@/lib/reader-groups";
import { accessChoices, collectionOptions } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { ARTICLE_REVISIONS_KEPT } from "@/server/operations/docs";

export default async function ArticlePage(props: PageProps<"/app/[project]/docs/[slug]">) {
  const [{ project: slug, slug: articleSlug }, search] = await Promise.all([props.params, props.searchParams]);
  // `?history` opens its History panel (`&revision=…`: a version picked in it).
  const showsHistory = search.history !== undefined;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const article = await prisma.article.findFirst({
    where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      showUpdatedDate: true,
      listing: true,
      ...levelSelect,
      customSlug: true,
      description: true,
      keywords: true,
      noindex: true,
      collection: { select: { slug: true, name: true } },
      changes: { select: { title: true, body: true, content: true, updatedAt: true, collection: { select: { slug: true, name: true } } } },
    },
  });
  if (!article) {
    notFound();
  }
  // The editor shows the version saved last: a published article's unpublished changes, if it has some.
  const edited = article.changes ?? article;
  const url = `${await portalAddress(slug)}/docs/${article.slug}`;
  const listing = article.listing.toLowerCase() as Listing;
  const [collections, access] = await Promise.all([collectionOptions(membership.project.id), accessChoices(membership.project.id)]);
  // "Who can read" inherits from its collection (the published one: readers' access follows it), or (in none) from the first tab.
  const parent = article.collection ? collections.find((c) => c.slug === article.collection!.slug) : access.firstTab;

  return (
    <>
      <PageHeader
        back={{ href: `/app/${slug}/docs`, label: "Docs" }}
        // On phones the form's title field shows it, right under this; from tablet width up it's in the top bar too, after "← Docs".
        title={<span className="sr-only topbar:not-sr-only">{article.title}</span>}
        description={
          article.publishedAt ? (
            <>
              Published {formatDate(article.publishedAt)} ·{" "}
              {listing === "hidden" || listing === "ai_only" ? (
                // No page to link to.
                LISTING_LABELS[listing]
              ) : (
                <>
                  {listing === "unlisted" && "Unlisted · "}
                  <Link href={url} target="_blank" className="break-all underline underline-offset-4">
                    {url}
                  </Link>
                </>
              )}
            </>
          ) : (
            "Draft"
          )
        }
        actions={
          <>
            <DocsFilter />
            <Link href="?history" scroll={false} className={buttonVariants({ variant: "ghost" })}>
              History
            </Link>
            <ArticleSettings
              projectSlug={slug}
              article={{
                slug: article.slug,
                listing,
                access: fromReadAccess(article.access),
                groups: claimsOf(article),
                noAccess: fromNoAccess(article.noAccess),
                customSlug: article.customSlug,
                description: article.description,
                keywords: article.keywords,
                noindex: article.noindex,
              }}
              groups={access.groups}
              inherit={{
                label: parent ? `Inherit from ${parent.name}` : "Inherit",
                description: access.inherits[parent?.slug ?? ""] ?? access.inherits[""]!,
                shows: access.shows[parent?.slug ?? ""] ?? "hide",
              }}
              preview={article.publishedAt ? previewUrl(access, `/docs/${article.slug}`) : undefined}
            />
            <ArticleActions projectSlug={slug} slug={article.slug} title={article.title} published={article.publishedAt !== null} />
          </>
        }
      />
      {article.changes && (
        <ArticleChanges
          projectSlug={slug}
          slug={article.slug}
          savedAt={article.changes.updatedAt.toISOString()}
          saved={timeAgo(article.changes.updatedAt)}
          diff={<ArticleDiff before={article} after={article.changes} same="Nothing: they're the same as the published version." />}
        />
      )}
      {/* New saved text starts the form afresh; publishing or unpublishing keeps unsaved edits. */}
      <ArticleForm
        key={createHash("sha256").update(JSON.stringify([edited.title, edited.content, edited.collection])).digest("base64url")}
        projectSlug={slug}
        article={{
          slug: article.slug,
          title: edited.title,
          content: displayDoc(edited) as Doc,
          collection: edited.collection?.slug ?? null,
          showUpdatedDate: article.showUpdatedDate,
          published: article.publishedAt !== null,
        }}
        collections={collections}
        mediaUrls={await mediaUrls(displayDoc(edited))}
      />
      <HistorySheet
        open={showsHistory}
        description={`Every save that changed “${article.title}”, newest first. The latest ${ARTICLE_REVISIONS_KEPT} are kept.`}
      >
        {showsHistory && (
          <ArticleHistory
            projectSlug={slug}
            article={article}
            current={edited}
            selectedId={typeof search.revision === "string" ? search.revision : undefined}
          />
        )}
      </HistorySheet>
    </>
  );
}
