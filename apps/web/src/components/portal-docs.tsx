import { ARTICLE_TITLE_ID, docHeadings, type Heading } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ArticleActions } from "@/components/article-actions";
import { ArticleFeedback } from "@/components/article-feedback";
import { BackLink } from "@/components/back-link";
import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { ArticleLinks, CollectionContents } from "@/components/docs-collections";
import { PageHeader } from "@/components/page-header";
import { PartRow } from "@/components/portal-nav";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import {
  articleMarkdown,
  docsContents,
  type DocsContents,
  type DocsPage,
  type DocsTabView,
  type DocsTree,
  type DocsTreeCollection,
  docsTabPath,
  docsTree,
  everyCollection,
  type TabLanding,
} from "@/server/docs-queries";
import { searchDocs } from "@/server/docs-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { currentReader } from "@/server/portal-access";
import { portalLinks } from "@/server/portal-base";

/** Published articles matching `query`, each with the passage that matched. */
async function SearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  const at = await portalLinks();
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  const results = project ? await searchDocs(project.id, query, 10, await currentReader(project.id)) : [];
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No articles match “${query}”`}
        description="Try other words, or browse all articles."
        action={
          <Link href={at("/docs")} className={buttonVariants({ variant: "outline" })}>
            All articles
          </Link>
        }
      />
    );
  }
  return (
    <ul aria-label="Search results" className="flex flex-col gap-4">
      {results.map((result) => (
        <li key={result.slug} className="flex flex-col gap-0.5">
          <Link href={at(`/docs/${result.slug}`)} className="break-words text-primary hover:underline">
            {result.title}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The new-post form on the portal's first board, with the question as the title. */
async function feedbackHref(projectSlug: string, question: string) {
  const at = await portalLinks();
  const board = await prisma.board.findFirst({ where: { project: { slug: projectSlug } }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return board && at(`${boardPath(board)}?${new URLSearchParams({ title: question.slice(0, MAX_POST_TITLE) })}`);
}

/** A search over every tab (`?q=` on /docs; the box is in the header and on the overviews): an AI answer, when on, and the results. */
export async function DocsSearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Docs" description="Guides and answers to common questions." />
      {answersEnabled() && (
        <DocsAnswer
          key={query}
          projectSlug={projectSlug}
          question={query}
          feedbackHref={await feedbackHref(projectSlug, query)}
          askAPerson={await askAPerson(projectSlug)}
        />
      )}
      <SearchResults projectSlug={projectSlug} query={query} />
    </div>
  );
}

/**
 * A tab's overview (`tab`; without tabs, all of the docs): its name ("Docs" on /docs), a search box,
 * a card per top-level collection, then (the first tab) the articles in none.
 */
async function DocsOverview({ docs, tab }: { docs: DocsContents; tab: DocsTabView | null }) {
  const at = await portalLinks();
  const { collections, uncollected } = tab ?? docs;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageHeader title={tab && tab.slug !== docs.home ? tab.name : "Docs"} description="Guides and answers to common questions." />
        {/* A plain GET form, like the header's: it works without JavaScript. */}
        <form role="search" action={at("/docs")} className="relative">
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" name="q" maxLength={200} placeholder="Search docs" aria-label="Search the docs" className="h-12 pl-11 text-base" />
        </form>
      </div>
      {collections.length === 0 && uncollected.length === 0 && (
        <EmptyState title="Nothing here yet" description="Articles show up here once they're published." />
      )}
      {collections.length > 0 && (
        <ul aria-label="Collections" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((collection) => (
            <li key={collection.slug}>
              <Link
                href={at(`/docs/${collection.slug}`)}
                className="flex h-full flex-col gap-2 rounded-xl border p-5 transition-colors hover:border-primary/50 hover:bg-accent/50"
              >
                {collection.icon && (
                  <span className="text-xl text-primary">
                    <CollectionIcon name={collection.icon} />
                  </span>
                )}
                <h2 className="font-heading font-semibold break-words">{collection.name}</h2>
                {collection.description && <p className="text-sm break-words text-muted-foreground">{collection.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className="font-heading text-lg font-bold tracking-tight">
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} href={(slug) => at(`/docs/${slug}`)} />
        </section>
      )}
    </div>
  );
}

/** A tab's path (/docs for the first; `tab` null without tabs): its overview, or the article or collection it shows in its place. */
export function DocsTabPage({ project, docs, tab, landing }: { project: string; docs: DocsContents; tab: DocsTabView | null; landing: TabLanding }) {
  switch (landing.kind) {
    case "article":
      return <DocsArticle project={project} slug={landing.slug} article={landing.article} />;
    case "collection":
      return <DocsCollectionPage page={landing} />;
    case "overview":
      return (
        <DocsLayout tree={docsTree(docs, tab?.slug ?? null, null)} current={null}>
          <DocsOverview docs={docs} tab={tab} />
        </DocsLayout>
      );
  }
}

/** An article's or collection's title and description for search engines and link previews (the caller adds the canonical address). */
export function docsPageMetadata(page: Extract<DocsPage, { kind: "article" | "collection" }>): Metadata {
  if (page.kind === "collection") {
    const { name, description } = page.collection;
    return { title: `${name} · Docs`, ...(description && { description }) };
  }
  const { article } = page;
  const text = article.body.replace(/\s+/g, " ").trim();
  return {
    title: `${article.title} · ${article.project.name}`,
    description: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
    // Unlisted: for people with the link, not search engines.
    ...(article.listing === "UNLISTED" && { robots: { index: false } }),
  };
}

/** A collection's page: its articles, then the collections in it. */
export async function DocsCollectionPage({ page }: { page: Extract<DocsPage, { kind: "collection" }> }) {
  const at = await portalLinks();
  const { docs, tab, parent, collection } = page;
  // The way back: the collection it's in, else its tab (on phones; wider screens have the tree).
  const back = parent ? `/docs/${parent.slug}` : tab ? docsTabPath(docs, tab.slug) : "/docs";
  return (
    <DocsLayout tree={docsTree(docs, tab?.slug ?? null, collection.slug)} current={collection.slug}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6">
          <BackLink href={at(back)} className="md:hidden">
            {parent ? parent.name : "Docs"}
          </BackLink>
          <PageHeader title={collection.name} description={collection.description} />
        </div>
        <CollectionContents collection={collection} href={(s) => at(`/docs/${s}`)} collectionHref={(s) => at(`/docs/${s}`)} />
      </div>
    </DocsLayout>
  );
}

/** Article `slug`'s page (at its own path, or a tab's showing it). */
export async function DocsArticle({ project, slug, article }: { project: string; slug: string; article: Extract<DocsPage, { kind: "article" }>["article"] }) {
  const at = await portalLinks();
  // Its tab and collection have pages for this reader when they have something to read (an unlisted
  // article may be all there is): the way back is its tab's, or /docs.
  const docs = await docsContents(project);
  const tab = docs.tabs.find((t) => t.slug === article.tab);
  const collection = article.collection && everyCollection(docs.collections).find((c) => c.slug === article.collection!.slug);
  // The tree: its tab's (the first tab's has the articles in none), its collection's branch open.
  const tree = docsTree(docs, article.tab ?? docs.home, article.collection?.slug ?? null);
  return (
    <DocsLayout tree={tree} current={slug} headings={docHeadings(article.doc)}>
      <article className="flex flex-col gap-6" aria-labelledby={ARTICLE_TITLE_ID}>
        {/* On phones; wider screens have the tree. */}
        <BackLink href={at(tab ? docsTabPath(docs, tab.slug) : "/docs")} className="md:hidden">
          Docs
        </BackLink>
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
          <h1 id={ARTICLE_TITLE_ID} className="font-heading text-2xl font-bold tracking-tight break-words">
            {article.title}
          </h1>
          {article.updatedAt && (
            <p className="text-sm text-muted-foreground">
              Updated <time dateTime={article.updatedAt.toISOString()}>{formatDate(article.updatedAt)}</time>
            </p>
          )}
        </div>
        <ArticleActions markdown={articleMarkdown(article)} markdownUrl={`${await portalAddress(project)}/docs/${slug}.md`} />
        <RichText doc={article.doc} mediaBaseUrl={mediaPublicUrl()} headingIds className="rich-text break-words" />
        <ArticleFeedback projectSlug={project} slug={slug} />
      </article>
    </DocsLayout>
  );
}

/** Docs' row under the header: its tabs with something to read (with two or more), `active` the one this page is in. */
export async function DocsTabsRow({ docs, active }: { docs: DocsContents; active: string | null }) {
  const at = await portalLinks();
  const links = docs.tabs.map((tab) => ({ href: at(docsTabPath(docs, tab.slug)), name: tab.name, active: tab.slug === active }));
  return <PartRow label="Docs tabs" links={links} wide />;
}

/**
 * The tab's collections (docsTree): top-level ones always open, the ones in them collapsible
 * (`<details>`, so it works without JavaScript), then the articles in none under "More".
 * `current` is the page's slug (one name per page under /docs), marked as the current page.
 */
async function DocsTree({ tree, current }: { tree: DocsTree; current: string | null }) {
  const at = await portalLinks();
  const link = (slug: string, name: React.ReactNode, className?: string) => (
    <Link
      href={at(`/docs/${slug}`)}
      aria-current={slug === current ? "page" : undefined}
      className={cn(
        "block rounded-md px-2 py-1 break-words text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground",
        className,
      )}
    >
      {name}
    </Link>
  );
  // A collection's name, after its icon.
  const named = (collection: DocsTreeCollection) => (
    <>
      <CollectionIcon name={collection.icon} />
      <span className="min-w-0">{collection.name}</span>
    </>
  );
  const articles = (list: { slug: string; title: string }[]) => list.map((article) => <li key={article.slug}>{link(article.slug, article.title)}</li>);
  const contents = (collection: DocsTreeCollection) => (
    <ul className="flex flex-col gap-0.5">
      {articles(collection.articles)}
      {collection.collections.map((child) => (
        <li key={child.slug}>
          <details open={child.open}>
            <summary className="flex cursor-pointer list-none items-center rounded-md hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground transition-transform [[open]>summary>&]:rotate-90" />
              {link(child.slug, named(child), "flex min-w-0 flex-1 items-center gap-2 pl-1")}
            </summary>
            <div className="ml-3 border-l pl-2">{contents(child)}</div>
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <nav aria-label="Docs" className="flex flex-col gap-5 text-sm">
      {tree.collections.map((collection) => (
        <div key={collection.slug} className="flex flex-col gap-1">
          {link(collection.slug, named(collection), "flex items-center gap-2 font-heading font-semibold text-foreground")}
          {contents(collection)}
        </div>
      ))}
      {tree.uncollected.length > 0 && (
        <div className="flex flex-col gap-1">
          {tree.collections.length > 0 && <p className="px-2 py-1 font-heading font-semibold">More</p>}
          <ul className="flex flex-col gap-0.5">{articles(tree.uncollected)}</ul>
        </div>
      )}
    </nav>
  );
}

/**
 * Every Docs page's columns: the tab's tree on the left (on phones, "Browse docs" above the page
 * instead), the page, and on an article its `headings` on the right ("On this page", on wide
 * screens, with two or more).
 */
export function DocsLayout({ tree, current, headings = [], children }: { tree: DocsTree; current: string | null; headings?: Heading[]; children: React.ReactNode }) {
  const hasTree = tree.collections.length > 0 || tree.uncollected.length > 0;
  return (
    <div className="flex gap-10">
      {hasTree && (
        <aside className="hidden w-60 shrink-0 md:block">
          <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto">
            <DocsTree tree={tree} current={current} />
          </div>
        </aside>
      )}
      <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-6">
        {hasTree && (
          <details className="rounded-xl border md:hidden">
            <summary className="cursor-pointer px-4 py-2 text-sm font-medium">Browse docs</summary>
            <div className="border-t p-2">
              <DocsTree tree={tree} current={current} />
            </div>
          </details>
        )}
        {children}
      </div>
      {headings.length >= 2 && (
        <aside className="hidden w-50 shrink-0 xl:block">
          <nav aria-label="On this page" className="sticky top-6 flex flex-col gap-2 text-sm">
            <p className="font-heading font-semibold">On this page</p>
            <ul className="flex flex-col gap-1.5">
              {headings.map((heading) => (
                <li key={heading.id} className={cn(heading.level === 3 && "pl-3")}>
                  <a href={`#${heading.id}`} className="break-words text-muted-foreground transition-colors hover:text-foreground">
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      )}
    </div>
  );
}
