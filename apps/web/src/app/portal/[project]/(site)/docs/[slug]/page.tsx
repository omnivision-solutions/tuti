import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { ArticleActions } from "@/components/article-actions";
import { ArticleFeedback } from "@/components/article-feedback";
import { BackLink } from "@/components/back-link";
import { CollectionContents, DocsTabs } from "@/components/docs-collections";
import { PageHeader } from "@/components/page-header";
import { DocsIndex } from "@/components/portal-docs";
import { formatDate } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { articleMarkdown, docsContents, type DocsPage, docsPage, docsTabPath, everyCollection } from "@/server/docs-queries";
import { portalLinks } from "@/server/portal-base";

/** Search results show the page's title and its first lines (an article's) or its description (a collection's). */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs/[slug]">): Promise<Metadata> {
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (page?.kind === "article") {
    const { article } = page;
    const text = article.body.replace(/\s+/g, " ").trim();
    return {
      title: `${article.title} · ${article.project.name}`,
      description: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
      // Unlisted: for people with the link, not search engines.
      ...(article.listing === "UNLISTED" && { robots: { index: false } }),
    };
  }
  if (page?.kind === "tab" || page?.kind === "collection") {
    const { name, description } = page.kind === "tab" ? { name: page.tab.name, description: "" } : page.collection;
    return {
      title: `${name} · Docs`,
      ...(description && { description }),
      alternates: { canonical: `${await portalAddress(project)}/docs/${slug}` },
    };
  }
  return {};
}

/** /docs/<slug>: an article, a tab or a collection (one name each), or where one went since. */
export default async function DocsSlugPage(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const at = await portalLinks();
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (!page) {
    notFound();
  }
  if (page.kind === "redirect") {
    permanentRedirect(at(page.path));
  }
  switch (page.kind) {
    case "tab":
      return <DocsIndex projectSlug={project} query="" docs={page.docs} tab={page.tab} />;
    case "collection": {
      const { docs, tab, parent, collection } = page;
      // The way back: the collection it's in, else its tab.
      const back = parent ? `/docs/${parent.slug}` : tab ? docsTabPath(docs, tab.slug) : "/docs";
      return (
        <div className="flex flex-col gap-8">
          {tab && <DocsTabs tabs={docs.tabs} active={tab.slug} href={(t) => at(docsTabPath(docs, t))} />}
          <div className="flex flex-col gap-6">
            <BackLink href={at(back)}>{parent ? parent.name : "Docs"}</BackLink>
            <PageHeader title={collection.name} description={collection.description} />
          </div>
          <CollectionContents collection={collection} href={(s) => at(`/docs/${s}`)} collectionHref={(s) => at(`/docs/${s}`)} />
        </div>
      );
    }
    case "article":
      return <ArticlePage project={project} slug={slug} article={page.article} />;
  }
}

async function ArticlePage({ project, slug, article }: { project: string; slug: string; article: Extract<DocsPage, { kind: "article" }>["article"] }) {
  const at = await portalLinks();
  // Its tab and collection have pages for this reader when they have something to read (an unlisted
  // article may be all there is): the way back is its tab's, or /docs.
  const docs = await docsContents(project);
  const tab = docs.tabs.find((t) => t.slug === article.tab);
  const collection = article.collection && everyCollection(docs.collections).find((c) => c.slug === article.collection!.slug);
  return (
    <div className="flex flex-col gap-8">
      <DocsTabs tabs={docs.tabs} active={article.tab ?? docs.home} href={(t) => at(docsTabPath(docs, t))} />
      <article className="flex flex-col gap-6" aria-labelledby="article-title">
        <BackLink href={at(tab ? docsTabPath(docs, tab.slug) : "/docs")}>Docs</BackLink>
        <div className="flex flex-col gap-1">
          {article.collection && (
            <p className="text-sm text-muted-foreground">
              {collection ? (
                <Link href={at(`/docs/${collection.slug}`)} className="hover:text-foreground hover:underline">
                  {collection.name}
                </Link>
              ) : (
                article.collection.name
              )}
            </p>
          )}
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
    </div>
  );
}
