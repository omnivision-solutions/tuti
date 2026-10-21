import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticleActions } from "@/components/article-actions";
import { ArticleFeedback } from "@/components/article-feedback";
import { BackLink } from "@/components/back-link";
import { formatDate } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { articleMarkdown, publishedArticle } from "@/server/help-queries";
import { portalLinks } from "@/server/portal-base";

/** Search results show the article's title and its first lines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs/[slug]">): Promise<Metadata> {
  const { project, slug } = await props.params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    return {};
  }
  const text = article.body.replace(/\s+/g, " ").trim();
  return {
    title: `${article.title} · ${article.project.name}`,
    description: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
    // Unlisted: for people with the link, not search engines.
    ...(article.listing === "UNLISTED" && { robots: { index: false } }),
  };
}

export default async function ArticlePage(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const at = await portalLinks();
  const { project, slug } = await props.params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    notFound();
  }
  return (
    <article className="flex flex-col gap-6" aria-labelledby="article-title">
      <BackLink href={at(article.section ? `/docs?${new URLSearchParams({ section: article.section })}` : "/docs")}>Help center</BackLink>
      <div className="flex flex-col gap-1">
        {article.collection && <p className="text-sm text-muted-foreground">{article.collection.name}</p>}
        <h1 id="article-title" className="font-heading text-2xl font-bold tracking-tight break-words">
          {article.title}
        </h1>
        {article.updatedAt && (
          <p className="text-sm text-muted-foreground">
            Updated <time dateTime={article.updatedAt.toISOString()}>{formatDate(article.updatedAt)}</time>
          </p>
        )}
      </div>
      <ArticleActions markdown={articleMarkdown(article)} markdownUrl={`${await portalAddress(project)}/docs/${slug}.md`} />
      <RichText doc={article.doc} mediaBaseUrl={mediaPublicUrl()} className="rich-text break-words" />
      <ArticleFeedback projectSlug={project} slug={slug} />
    </article>
  );
}
