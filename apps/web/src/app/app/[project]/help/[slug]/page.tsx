import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ArticleActions, ArticleForm } from "@/components/help";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { portalUrl } from "@/lib/hosts";
import { displayDoc } from "@/server/content";
import { collectionOptions } from "@/server/help-queries";
import { getMembership } from "@/server/membership";

export default async function ArticlePage(props: PageProps<"/app/[project]/help/[slug]">) {
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
      collection: { select: { slug: true } },
    },
  });
  if (!article) {
    notFound();
  }
  const url = `${portalUrl(slug)}/help/${article.slug}`;

  return (
    <>
      <BackLink href={`/app/${slug}/help`}>Help center</BackLink>
      <PageHeader
        title={article.title}
        description={
          article.publishedAt ? (
            <>
              Published {formatDate(article.publishedAt)} ·{" "}
              <Link href={url} target="_blank" className="break-all underline underline-offset-4">
                {url}
              </Link>
            </>
          ) : (
            "Draft"
          )
        }
        actions={
          <>
            <Link href={`/app/${slug}/help/${article.slug}/history`} className={buttonVariants({ variant: "ghost" })}>
              History
            </Link>
            <ArticleActions projectSlug={slug} slug={article.slug} title={article.title} published={article.publishedAt !== null} />
          </>
        }
      />
      {/* New saved text starts the form afresh; publishing or unpublishing keeps unsaved edits. */}
      <ArticleForm
        key={createHash("sha256").update(JSON.stringify([article.title, article.content, article.collection])).digest("base64url")}
        projectSlug={slug}
        article={{
          slug: article.slug,
          title: article.title,
          content: displayDoc(article) as Doc,
          collection: article.collection?.slug ?? null,
          showUpdatedDate: article.showUpdatedDate,
        }}
        collections={await collectionOptions(membership.project.id)}
        mediaBaseUrl={mediaPublicUrl()}
      />
    </>
  );
}
