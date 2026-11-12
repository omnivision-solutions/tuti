import { cn } from "cn";
import { docHeadings, type Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { editsInChanges } from "@tuti/jobs";
import { aiProvider, articleVersionsNote, planIncludes } from "@tuti/shared";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArticleSettings } from "@/components/article-settings";
import { previewUrl } from "@/lib/portal-base";
import {
  ArticleActions,
  ArticleChanges,
  ArticleEditor,
  ArticleForm,
  ArticleSaveButton,
} from "@/components/docs";
import { ArticleDiff } from "@/components/article-diff";
import { ArticleStateBadge } from "@/components/docs-article-rows";
import { ArticleHistory } from "@/components/article-history";
import { ArticleVerify } from "@/components/article-verify";
import { ArticleTools } from "@/components/article-tools";
import { DocsMore, DocsPageHeader } from "@/components/docs-page-header";
import { buttonVariants } from "@/components/ui/button";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDay, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import {
  fromNoAccess,
  fromReadAccess,
  publishReaders,
} from "@/lib/read-access";
import { claimsOf, levelSelect } from "@/lib/reader-groups";
import {
  accessChoices,
  collectionOptions,
  namedLevel,
} from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { articleVerifications, verifyUnavailable } from "@/server/operations/verify";
import { markedRun } from "@/lib/docs-review";

export default async function ArticlePage(
  props: PageProps<"/app/[project]/docs/[slug]">,
) {
  const [{ project: slug, slug: articleSlug }, search] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
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
    where: {
      article: {
        projectId: membership.project.id,
        slug: articleSlug,
        deletedAt: null,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Its id, and when it was saved: the header's "Edited …" (`updatedAt` moves on writes that aren't saves, a move).
    select: { id: true, createdAt: true },
  });
  // A draft's: Autopilot's edits waiting in it, which publishing it takes live (and only those), read before its text:
  // one landing between the two is in the text but not here, so Publish is refused rather than taking it live unseen.
  const waitingDraft = await prisma.article.findFirst({
    where: {
      projectId: membership.project.id,
      slug: articleSlug,
      deletedAt: null,
      publishedAt: null,
    },
    select: { id: true },
  });
  const autopilotEdits = waitingDraft
    ? (await editsInChanges(waitingDraft.id)).map((edit) => edit.actionId)
    : [];
  const article = await prisma.article.findFirst({
    where: {
      projectId: membership.project.id,
      slug: articleSlug,
      deletedAt: null,
    },
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
      changes: {
        select: {
          title: true,
          body: true,
          content: true,
          updatedAt: true,
          collection: { select: { slug: true, name: true } },
        },
      },
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
    prisma.project.findUniqueOrThrow({
      where: { id: membership.project.id },
      select: { plan: true, portalAccess: true },
    }),
  ]);
  // "Who can read" inherits from its collection (the published one: readers' access follows it), or (in none) from the first tab.
  const parent = article.collection
    ? collections.find((c) => c.slug === article.collection!.slug)
    : access.firstTab;
  // Who reads it once published: everything above it, and its own "Who can read".
  const readers = publishReaders(
    [
      ...(access.levels[parent?.slug ?? ""] ?? access.levels[""]!),
      namedLevel(article, new Map(access.groups.map((g) => [g.key, g.name]))),
    ],
    {
      privatePortal: portalAccess === "PRIVATE",
      groupsOn: planIncludes(plan, "privatePortal"),
      listing,
      indexed: !article.noindex && !article.sample,
    },
  );

  return (
    // Save in the top bar submits the form below, and says when it's saving; Settings beside it saves the rest.
    <ArticleEditor collections={collections}>
      <ArticleTools
        settings={
          <ArticleSettings
            inline
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
                description:
                  access.inherits[parent?.slug ?? ""] ?? access.inherits[""]!,
                shows: access.shows[parent?.slug ?? ""] ?? "hide",
              },
              preview: article.publishedAt
                ? previewUrl(access, `/docs/${article.slug}`)
                : undefined,
            }}
          />
        }
        history={
          showsHistory ? (
            <ArticleHistory
              projectSlug={slug}
              article={article}
              current={edited}
              limit={typeof search.versions === "string" ? Math.min(1000, Math.max(10, Number(search.versions) || 10)) : 10}
              keep={keep}
              selectedId={
                typeof search.revision === "string"
                  ? search.revision
                  : undefined
              }
            />
          ) : null
        }
        verify={
          showsVerify ? (
            <ArticleVerify
              projectSlug={slug}
              article={article}
              unavailable={await verifyUnavailable(
                membership.project.id,
                article.publishedAt !== null,
              )}
              provider={aiProvider()}
            />
          ) : null
        }
        historyNote={`Every save that changed “${article.title}”, newest first. ${articleVersionsNote(plan)}`}
      >
        <section className={cn(
          "docs-editor-page [&_.article-text_p]:relative [&_.article-text_blockquote]:relative [&_.article-text_blockquote]:rounded-[10px]",
          "[&_.article-text_blockquote]:border-0 [&_.article-text_blockquote]:bg-soft [&_.article-text_blockquote]:py-3",
          "[&_.article-text_blockquote]:pr-4 [&_.article-text_blockquote]:pl-10 [&_.article-text_blockquote]:text-soft-foreground",
          "[&_.article-text_blockquote]:text-[14px] [&_.article-text_blockquote]:before:absolute [&_.article-text_blockquote]:before:left-3",
          "[&_.article-text_blockquote]:before:top-3.5 [&_.article-text_blockquote]:before:text-primary",
          "[&_.article-text_blockquote]:before:content-['i'] [&_.article-text_blockquote]:before:flex [&_.article-text_blockquote]:before:size-3.5 [&_.article-text_blockquote]:before:items-center [&_.article-text_blockquote]:before:justify-center [&_.article-text_blockquote]:before:rounded-full [&_.article-text_blockquote]:before:border [&_.article-text_blockquote]:before:border-current [&_.article-text_blockquote]:before:font-mono [&_.article-text_blockquote]:before:text-xs [&_.article-text_blockquote]:before:leading-none flex flex-col flex-1 min-w-0 overflow-hidden [--docs-pad:0px]",
          "@max-[61rem]/app:[&_.docs-article-form]:px-7 @max-[61rem]/app:[&_.docs-article-form]:max-w-[min(43rem,_calc(100%_-_56px))]",
          "max-sm:[&_.docs-article-form]:p-[20px_23px_48px] max-sm:[&_.docs-article-form]:max-w-[calc(100%_-_46px)]",
          "[&_.article-text]:text-[15.5px] [&_.article-text]:leading-[1.7]",
          "[&_.article-text]:gap-3.5 [&_.article-text_h2]:text-[21px] [&_.article-text_h2]:mt-3 [&_.article-text_h2]:leading-[1.3]",
          "[&_.article-text_h3]:text-[19px] [&_.article-text_h3]:mt-3 [&_.article-text_li_+_li]:mt-1 max-sm:[&_.article-text]:text-[15px]",
          "max-sm:[&_.article-text]:leading-[1.7] max-sm:[&_.article-text_h2]:text-[21px] max-sm:[&_.article-text_h2]:mt-3 min-w-0 min-h-0",
          "rounded-2xl bg-card ring-1 ring-border",
        )}>
          <DocsPageHeader
            back={{
              href: fromReview
                ? `/app/${slug}/autopilot/articles/${article.id}`
                : edited.collection
                  ? `/app/${slug}/docs/collections/${edited.collection.slug}`
                  : `/app/${slug}/docs`,
              label: fromReview ? "Review" : (edited.collection?.name ?? "All articles"),
            }}
            title={edited.title}
            titleInForm
            actions={
              <>
              <div className={cn(
                "docs-editor-state mr-2 flex min-w-0 items-center gap-3 text-xs whitespace-nowrap text-muted-foreground [&_[data-slot='badge']]:text-xs",
                // On phones the way back keeps the room: Publish says it's a draft, Open is in More actions; changes keep their controls.
                "@max-[40rem]/app:[&>:not(#article-state-tools)]:hidden",
              )}>
                {article.changes ? (
                  <span id="article-state-tools" className="relative" />
                ) : (
                  <ArticleStateBadge
                    state={!article.publishedAt ? "draft" : "published"}
                  />
                )}
                <span>
                  {article.publishedAt
                    ? `Published ${formatDay(article.publishedAt)} ${article.publishedAt.getUTCFullYear()}`
                    : `Edited ${timeAgo(newest?.createdAt ?? article.updatedAt)}`}
                  {article.publishedAt &&
                    listing !== "everywhere" &&
                    ` · ${LISTING_LABELS[listing]}`}
                </span>
                {article.publishedAt &&
                  listing !== "hidden" &&
                  listing !== "ai_only" && (
                    <Link
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open on help center"
                      className="docs-live-link inline-flex gap-1.5 items-center text-muted-foreground text-[13px] whitespace-nowrap [&:hover]:text-primary"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      Open
                    </Link>
                  )}
              </div>
              <div className={cn(
                "docs-editor-actions flex items-center gap-1.5 shrink-0",
                "[&_.docs-article-save]:text-muted-foreground [&_.docs-article-save]:bg-transparent",
                "[&_.docs-article-save]:shadow-none [&_.docs-article-save]:ring-0 [&_.docs-article-save]:border-[transparent] [&_.docs-article-save]:p-[0_3px]",
                "[&_.docs-article-save]:text-[13px]",
              )}>
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
                {article.changes && (
                  <ArticleChanges
                    projectSlug={slug}
                    slug={article.slug}
                    savedAt={article.changes.updatedAt.toISOString()}
                    saved={timeAgo(article.changes.updatedAt)}
                    compact
                    diff={
                      <ArticleDiff
                        before={article}
                        after={article.changes}
                        same="Nothing: they're the same as the published version."
                      />
                    }
                  />
                )}
                <DocsMore>
                  {article.publishedAt && listing !== "hidden" && listing !== "ai_only" && (
                    <Link href={url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      <ExternalLinkIcon />
                      View on help center
                    </Link>
                  )}
                  {article.publishedAt !== null && (
                    <ArticleActions
                      projectSlug={slug}
                      slug={article.slug}
                      title={article.title}
                      published
                      part="publish"
                      readers={readers}
                      autopilotEdits={autopilotEdits}
                    />
                  )}
                  <ArticleActions
                    projectSlug={slug}
                    slug={article.slug}
                    title={article.title}
                    published={article.publishedAt !== null}
                    part="delete"
                  />
                </DocsMore>
              </div>
              </>
            }
          />
          <div id="article-toolbar" className={cn(
            "docs-format-row flex items-center gap-2.5 shrink-0 min-h-12 p-[5px_18px] border-b border-border bg-card z-15",
            "[&_>_[aria-label='Formatting']]:flex-nowrap [&_>_[aria-label='Formatting']]:min-w-0 [&_>_[aria-label='Formatting']]:overflow-x-auto",
            "[&_>_[aria-label='Formatting']]:[scrollbar-width:none] [&_[data-slot='button']]:min-w-7.25 [&_[data-slot='button']]:h-7.5",
            "[&_[data-slot='button']]:text-muted-foreground [&_svg]:w-4 [&_svg]:h-4 @max-[77rem]/app:px-3 @max-[77rem]/app:gap-1 @max-[77rem]/app:[&_[aria-label='Quote']]:hidden",
            "@max-[77rem]/app:[&_button[aria-label='Code']]:hidden @max-[77rem]/app:[&_button[aria-label='Table']]:hidden max-sm:px-2.5 max-sm:gap-0.75 max-sm:min-h-11",
            "max-sm:[&_>_[aria-label='Formatting']]:gap-0 max-sm:[&_[data-slot='button']]:min-w-6.25 max-sm:[&_[data-slot='button']]:h-7",
            "max-sm:[&_[data-slot='button']]:p-0 max-sm:[&_svg]:w-3.75 max-sm:[&_svg]:h-3.75 max-sm:[&_.docs-toolbar-separator]:mx-0.5",
            "max-sm:[&_[aria-label='Quote']]:hidden max-sm:[&_button[aria-label='Code']]:hidden max-sm:[&_button[aria-label='Table']]:hidden",
            "[&_[data-slot='button']:has(svg:only-child)]:w-7.25 [&_[data-slot='button']:has(svg:only-child)]:px-0",
            "max-sm:[&_[data-slot='button']:has(svg:only-child)]:w-6.25",
          )} />
          <div className="docs-editor-scroll overflow-auto min-h-0 flex-1 [scrollbar-width:thin] [scroll-padding-top:24px]">
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
              findings={showsVerify ? markedRun(await articleVerifications(article.id))?.statements : undefined}
              sections={docHeadings(displayDoc(edited)).length >= 2}
            />
          </div>
        </section>
      </ArticleTools>
    </ArticleEditor>
  );
}
