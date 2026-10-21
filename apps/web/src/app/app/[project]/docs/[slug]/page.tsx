import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ArticleActions, ArticleChanges, ArticleForm } from "@/components/help";
import { ArticleDiff } from "@/components/line-diff";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { formatDate, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import { collectionOptions } from "@/server/help-queries";
import { getMembership } from "@/server/membership";

export default async function ArticlePage(props: PageProps<"/app/[project]/docs/[slug]">) {
  const { project: slug, slug: articleSlug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const article = await prisma.article.findFirst({
    where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null },
    select: {
      slug: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      showUpdatedDate: true,
      listing: true,
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

  return (
    <>
      <BackLink href={`/app/${slug}/docs`}>Docs</BackLink>
      <PageHeader
        title={article.title}
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
            <Link href={`/app/${slug}/docs/${article.slug}/history`} className={buttonVariants({ variant: "ghost" })}>
              History
            </Link>
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
          listing,
          published: article.publishedAt !== null,
        }}
        collections={await collectionOptions(membership.project.id)}
        mediaBaseUrl={mediaPublicUrl()}
      />
    </>
  );
}
