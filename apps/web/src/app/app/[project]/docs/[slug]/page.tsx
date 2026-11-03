
import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { aiProvider, articleVersionsKept } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleSettings } from "@/components/article-settings";
import { previewUrl } from "@/lib/portal-base";
import { ArticleActions, ArticleChanges, ArticleEditor, ArticleForm, ArticleSaveButton } from "@/components/docs";
import { ArticleDiff } from "@/components/article-diff";
import { ArticleHistory } from "@/components/article-history";
import { ArticleVerify } from "@/components/article-verify";
import { HistorySheet } from "@/components/history-sheet";
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
import { verifyUnavailable } from "@/server/operations/verify";

export default async function ArticlePage(props: PageProps<"/app/[project]/docs/[slug]">) {
  const [{ project: slug, slug: articleSlug }, search] = await Promise.all([props.params, props.searchParams]);
  // `?history` opens its History panel (`&revision=…`: a version picked in it); `?verify` its Verify panel.
  const showsHistory = search.history !== undefined;
  const showsVerify = search.verify !== undefined;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  // The newest version, read before the text: an edit landing between the two leaves the text newer than it, never
  // older, so the editor's save is checked against it rather than taken as made on it.
  const newest = await prisma.articleRevision.findFirst({
    where: { article: { projectId: membership.project.id, slug: articleSlug, deletedAt: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
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
  const [collections, access, { plan }] = await Promise.all([
    collectionOptions(membership.project.id),
    accessChoices(membership.project.id),
    prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } }),
  ]);
  const kept = articleVersionsKept(plan);
  // "Who can read" inherits from its collection (the published one: readers' access follows it), or (in none) from the first tab.
  const parent = article.collection ? collections.find((c) => c.slug === article.collection!.slug) : access.firstTab;

  return (
    // Save in the top bar submits the form below, and says when it's saving; Settings beside it saves the rest.
    <ArticleEditor collections={collections}>
      <PageHeader
        back={{ href: `/app/${slug}/docs`, label: "Docs" }}
        // On phones the form's title field shows it, right under this; from tablet width up it's in the top bar too, after "← Docs".
        title={<span className="sr-only topbar:not-sr-only">{article.title}</span>}
        meta={
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
            <ArticleSettings
              saved={{
                projectSlug: slug,
                article: {
                  slug: article.slug,
                  published: article.publishedAt !== null,
                  collection: edited.collection?.slug ?? null,
                  showUpdatedDate: article.showUpdatedDate,
                  listing,
                  access: fromReadAccess(article.access),
                  groups: claimsOf(article),
                  noAccess: fromNoAccess(article.noAccess),
                  customSlug: article.customSlug,
                  description: article.description,
                  keywords: article.keywords,
                  noindex: article.noindex,
                },
                groups: access.groups,
                inherit: {
                  label: parent ? `Inherit from ${parent.name}` : "Inherit",
                  description: access.inherits[parent?.slug ?? ""] ?? access.inherits[""]!,
                  shows: access.shows[parent?.slug ?? ""] ?? "hide",
                },
                preview: article.publishedAt ? previewUrl(access, `/docs/${article.slug}`) : undefined,
              }}
            />
            <ArticleSaveButton />
            <ArticleActions projectSlug={slug} slug={article.slug} title={article.title} published={article.publishedAt !== null} part="publish" />
          </>
        }
        more={
          <>
            <Link href="?history" scroll={false} className={buttonVariants({ variant: "ghost" })}>
              History
            </Link>
            <Link href="?verify" scroll={false} className={buttonVariants({ variant: "ghost" })}>
              Verify
            </Link>
            <ArticleActions projectSlug={slug} slug={article.slug} title={article.title} published={article.publishedAt !== null} part="delete" />
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
      {/* A newer saved version starts the form afresh unless it has unsaved edits, which are never replaced (ArticleForm). */}
      <ArticleForm
        projectSlug={slug}
        article={{
          slug: article.slug,
          title: edited.title,
          content: displayDoc(edited) as Doc,
          published: article.publishedAt !== null,
          revision: newest?.id ?? null,
        }}
        mediaUrls={await mediaUrls(displayDoc(edited))}
      />
      <HistorySheet
        open={showsHistory}
        description={`Every save that changed “${article.title}”, newest first. ${kept === 1 ? "Only the latest is kept." : `The latest ${kept} are kept.`}`}
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
      <HistorySheet open={showsVerify} title="Verify" description={`Each check of “${article.title}” against your repository, newest first.`}>
        {showsVerify && (
          <ArticleVerify projectSlug={slug} article={article} unavailable={await verifyUnavailable(membership.project.id, article.publishedAt !== null)} provider={aiProvider()} />
        )}
      </HistorySheet>
    </ArticleEditor>
  );
}
