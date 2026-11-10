
import { docHeadings, type Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { editsInChanges } from "@tuti/jobs";
import { aiProvider, articleVersionsNote, planIncludes } from "@tuti/shared";
import { ExternalLinkIcon, HistoryIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleSettings } from "@/components/article-settings";
import { previewUrl } from "@/lib/portal-base";
import { ArticleActions, ArticleChanges, ArticleEditor, ArticleForm, ArticleSaveButton } from "@/components/docs";
import { ArticleDiff } from "@/components/article-diff";
import { ArticleStateBadge } from "@/components/docs-article-rows";
import { ArticleHistory } from "@/components/article-history";
import { ArticleVerify } from "@/components/article-verify";
import { HistorySheet } from "@/components/history-sheet";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import { fromNoAccess, fromReadAccess, publishReaders } from "@/lib/read-access";
import { claimsOf, levelSelect } from "@/lib/reader-groups";
import { accessChoices, collectionOptions, namedLevel } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { verifyUnavailable } from "@/server/operations/verify";

export default async function ArticlePage(props: PageProps<"/app/[project]/docs/[slug]">) {
  const [{ project: slug, slug: articleSlug }, search] = await Promise.all([props.params, props.searchParams]);
  // `?history` opens its History panel (`&revision=…`: a version picked in it); `?verify` its Verify panel.
  const showsHistory = search.history !== undefined;
  const showsVerify = search.verify !== undefined;
  // Opened from Autopilot's review (Edit before publishing): kept through its panels' links, for the way back.
  const fromReview = search.from === "autopilot";
  const keep = fromReview ? "&from=autopilot" : "";
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  // The newest version, read before the text: an edit landing between the two leaves the text newer than it, never
  // older, so the editor's save is checked against it rather than taken as made on it.
  const newest = await prisma.articleRevision.findFirst({
    where: { article: { projectId: membership.project.id, slug: articleSlug, deletedAt: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Its id, and when it was saved: the header's "Edited …" (`updatedAt` moves on writes that aren't saves, a move).
    select: { id: true, createdAt: true },
  });
  // A draft's: Autopilot's edits waiting in it, which publishing it takes live (and only those), read before its text:
  // one landing between the two is in the text but not here, so Publish is refused rather than taking it live unseen.
  const waitingDraft = await prisma.article.findFirst({ where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null, publishedAt: null }, select: { id: true } });
  const autopilotEdits = waitingDraft ? (await editsInChanges(waitingDraft.id)).map((edit) => edit.actionId) : [];
  const article = await prisma.article.findFirst({
    where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      updatedAt: true,
      showUpdatedDate: true,
      listing: true,
      ...levelSelect,
      customSlug: true,
      description: true,
      keywords: true,
      noindex: true,
      sample: true,
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
  const [collections, access, { plan, portalAccess }] = await Promise.all([
    collectionOptions(membership.project.id),
    accessChoices(membership.project.id),
    prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true, portalAccess: true } }),
  ]);
  // "Who can read" inherits from its collection (the published one: readers' access follows it), or (in none) from the first tab.
  const parent = article.collection ? collections.find((c) => c.slug === article.collection!.slug) : access.firstTab;
  // Who reads it once published: everything above it, and its own "Who can read".
  const readers = publishReaders(
    [...(access.levels[parent?.slug ?? ""] ?? access.levels[""]!), namedLevel(article, new Map(access.groups.map((g) => [g.key, g.name])))],
    { privatePortal: portalAccess === "PRIVATE", groupsOn: planIncludes(plan, "privatePortal"), listing, indexed: !article.noindex && !article.sample },
  );

  return (
    // Save in the top bar submits the form below, and says when it's saving; Settings beside it saves the rest.
    <ArticleEditor collections={collections}>
      <PageHeader
        // Opened from its review in Autopilot (Edit before publishing): the way back there.
        // Opened from its review in Autopilot (Edit before publishing): the way back there. Else its collection's page.
        back={
          fromReview
            ? { href: `/app/${slug}/autopilot/articles/${article.id}`, label: "Review" }
            : edited.collection
              ? { href: `/app/${slug}/docs/collections/${edited.collection.slug}`, label: edited.collection.name }
              : { href: `/app/${slug}/docs`, label: "Docs" }
        }
        // The form's title field shows it, right under this.
        title={article.title}
        titleInForm
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ArticleStateBadge state={!article.publishedAt ? "draft" : article.changes ? "changes" : "published"} />
            <span>
              {article.publishedAt ? formatDate(article.publishedAt) : `Edited ${timeAgo(newest?.createdAt ?? article.updatedAt)}`}
              {article.publishedAt && listing !== "everywhere" && ` · ${LISTING_LABELS[listing]}`}
            </span>
          </span>
        }
        // An editor: Settings, Save and Publish stay in the top bar as the text scrolls (on phones, a bar at the bottom).
        pinActions
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
            {/* Settings and its panels stay quiet beside Save. History and Verify have names from a wide laptop up,
                icons (named on hover and to the ear) under it. */}
            <Link href={`?history${keep}`} scroll={false} aria-label="History" title="History" className={buttonVariants({ variant: "ghost" })}>
              <HistoryIcon aria-hidden />
              <span className="hidden xl:inline">History</span>
            </Link>
            <Link href={`?verify${keep}`} scroll={false} aria-label="Verify" title="Verify against your code" className={buttonVariants({ variant: "ghost" })}>
              <ShieldCheckIcon aria-hidden />
              <span className="hidden xl:inline">Verify</span>
            </Link>
            <ArticleSaveButton outline={article.publishedAt === null} />
            {article.publishedAt === null && (
              <ArticleActions
                projectSlug={slug}
                slug={article.slug}
                title={article.title}
                published={false}
                part="publish"
                readers={readers}
                autopilotEdits={autopilotEdits}
              />
            )}
          </>
        }
        more={
          <>
            {/* Its page on the portal, in words, first in the menu. */}
            {article.publishedAt && listing !== "hidden" && listing !== "ai_only" && (
              <Link href={url} target="_blank" title={url} className={buttonVariants({ variant: "ghost" })}>
                <ExternalLinkIcon aria-hidden />
                View on portal
              </Link>
            )}
            {article.publishedAt !== null && (
              <ArticleActions projectSlug={slug} slug={article.slug} title={article.title} published part="publish" readers={readers} autopilotEdits={autopilotEdits} />
            )}
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
        key={`${slug}/${article.slug}`}
        projectSlug={slug}
        article={{
          slug: article.slug,
          title: edited.title,
          content: displayDoc(edited) as Doc,
          published: article.publishedAt !== null,
          revision: newest?.id ?? null,
        }}
        mediaUrls={await mediaUrls(displayDoc(edited))}
        // As the portal measures it (portal-docs' `outlined`).
        sections={docHeadings(displayDoc(edited)).length >= 2}
      />
      <HistorySheet
        open={showsHistory}
        description={`Newest first. ${articleVersionsNote(plan)}`}
      >
        {showsHistory && (
          <ArticleHistory
            projectSlug={slug}
            article={article}
            current={edited}
            keep={keep}
            selectedId={typeof search.revision === "string" ? search.revision : undefined}
          />
        )}
      </HistorySheet>
      <HistorySheet open={showsVerify} title="Verify" description={`“${article.title}” against your repository`}>
        {showsVerify && (
          <ArticleVerify projectSlug={slug} article={article} unavailable={await verifyUnavailable(membership.project.id, article.publishedAt !== null)} provider={aiProvider()} />
        )}
      </HistorySheet>
    </ArticleEditor>
  );
}
