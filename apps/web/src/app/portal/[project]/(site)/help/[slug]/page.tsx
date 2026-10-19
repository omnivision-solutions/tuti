import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticleActions } from "@/components/article-actions";
import { BackLink } from "@/components/back-link";
import { portalUrl } from "@/lib/hosts";
import { articleMarkdown, publishedArticle } from "@/server/help-queries";

/** Search results show the article's title and its first lines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/help/[slug]">): Promise<Metadata> {
  const { project, slug } = await props.params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    return {};
  }
  const text = article.body.replace(/\s+/g, " ").trim();
  return {
    title: `${article.title} · ${article.project.name}`,
    description: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
  };
}

export default async function ArticlePage(props: PageProps<"/portal/[project]/help/[slug]">) {
  const { project, slug } = await props.params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    notFound();
  }
  return (
    <article className="flex flex-col gap-6" aria-labelledby="article-title">
      <BackLink href="/help">Help center</BackLink>
      <div className="flex flex-col gap-1">
        {article.collection && <p className="text-sm text-muted-foreground">{article.collection.name}</p>}
        <h1 id="article-title" className="font-heading text-2xl font-bold tracking-tight break-words">
          {article.title}
        </h1>
      </div>
      <ArticleActions markdown={articleMarkdown(article)} markdownUrl={`${portalUrl(project)}/help/${slug}.md`} />
      <RichText doc={article.doc} mediaBaseUrl={mediaPublicUrl()} className="rich-text break-words" />
    </article>
  );
}
