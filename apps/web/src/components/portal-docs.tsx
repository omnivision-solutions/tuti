import { ARTICLE_TITLE_ID, docHeadings, type Heading } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { prisma } from "@tuti/db";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import type { Metadata, ResolvingMetadata } from "next";
import Link from "next/link";

import { ArticleActions, ArticleUpdated } from "@/components/article-actions";
import { DOCS_HEADING, DocsHomeHeader, PopularArticles } from "@/components/docs-home";
import { OnThisPage } from "@/components/on-this-page";
import { DocsSidebarLinks, PortalFooter } from "@/components/portal-look";
import { ArticleFeedback, ArticleViewCount } from "@/components/article-feedback";
import { allCollections } from "@/lib/docs-level-above";
import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { ArticleLinks, CollectionContents, LockedMark } from "@/components/docs-collections";
import { PageHeader } from "@/components/page-header";
import { PartRow } from "@/components/portal-nav";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import {
  articleCount,
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
  type LockedArticle,
  popularArticles,
  type TabLanding,
} from "@/server/docs-queries";
import { searchForReader } from "@/server/docs-search";
import { PortalMenuPart } from "@/components/portal-menu";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";

/** Published articles matching `query`, each with the passage that matched (locked ones by their title, with none). */
async function SearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  const at = await portalLinks();
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  const results = project ? await searchForReader(project.id, projectSlug, query, 10) : [];
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
            {result.locked && <LockedMark />}
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
 * A tab's overview (`tab`; without tabs, all of the docs): its name ("Docs" on /docs), a card per
 * top-level collection with how many articles it has, then (the first tab) the articles in none.
 * Searching and asking are the header's box.
 */
async function DocsOverview({ project, docs, tab }: { project: string; docs: DocsContents; tab: DocsTabView | null }) {
  const at = await portalLinks();
  const { collections, uncollected } = tab ?? docs;
  // The docs' home (the first tab's overview, or all of the docs) has the team's heading and popular articles.
  const home = !tab || tab.slug === docs.home;
  const popular = home ? (await popularArticles(project, docs)).map((article) => ({ href: at(`/docs/${article.slug}`), title: article.title })) : [];
  return (
    <div className="flex flex-col gap-8">
      {home ? <DocsHomeHeader /> : <PageHeader title={tab.name} description={DOCS_HEADING.subtitle} />}
      <PopularArticles articles={popular} />
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
                <h2 className="font-heading font-semibold break-words">
                  {collection.name}
                  {collection.locked && <LockedMark />}
                </h2>
                {collection.description && <p className="text-sm break-words text-muted-foreground">{collection.description}</p>}
                <ArticleCount count={articleCount(collection)} />
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

/** A collection card's "2 articles": what this reader may open in it (none in a locked one, which shows nothing). */
function ArticleCount({ count }: { count: number }) {
  return count > 0 && <p className="mt-auto pt-1 text-xs text-muted-foreground">{count === 1 ? "1 article" : `${count} articles`}</p>;
}

/**
 * What a page this reader may not read, but sees with a lock, says in place of what's on it: to
 * sign in (and come back here), or that they don't have access.
 */
function LockedMessage({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border p-5">
      <p className="flex items-center gap-2 font-medium">
        <LockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {signedIn ? "You don't have access to this." : "Sign in to read this."}
      </p>
      {!signedIn && <SignInLink className={buttonVariants()}>Sign in</SignInLink>}
    </div>
  );
}

/**
 * A tab's path (/docs for the first; `tab` null without tabs): its overview, or the article or
 * collection it shows in its place; a locked tab, its name and LockedMessage.
 */
export function DocsTabPage({ project, docs, tab, landing }: { project: string; docs: DocsContents; tab: DocsTabView | null; landing: TabLanding }) {
  if (tab?.locked) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <PageHeader title={tab.slug !== docs.home ? tab.name : "Docs"} />
        <LockedMessage signedIn={docs.signedIn} />
        <PortalFooter docs />
      </div>
    );
  }
  switch (landing.kind) {
    case "article":
      return <DocsArticle project={project} slug={landing.slug} article={landing.article} />;
    case "collection":
      return <DocsCollectionPage page={landing} />;
    case "overview":
      // Its cards are the collections: no tree beside them.
      return (
        <DocsLayout tree={null} current={null}>
          <DocsOverview project={project} docs={docs} tab={tab} />
        </DocsLayout>
      );
  }
}

/**
 * An article's or collection's title and description for search engines and link previews (the
 * caller adds the canonical address). A locked one: its title only, and not for search engines.
 */
export function docsPageMetadata(page: Extract<DocsPage, { kind: "article" | "locked" | "collection" }>): Metadata {
  if (page.kind === "locked") {
    return { title: `${page.article.title} · Docs`, robots: { index: false } };
  }
  if (page.kind === "collection") {
    const { name, description, locked } = page.collection;
    return { title: `${name} · Docs`, ...(description && { description }), ...(locked && { robots: { index: false } }) };
  }
  const { article } = page;
  const text = article.body.replace(/\s+/g, " ").trim();
  // The team's meta description, else the text's first lines.
  const description = article.description || (text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text);
  return {
    title: `${article.title} · ${article.project.name}`,
    description,
    openGraph: { title: article.title, description },
    // Unlisted: for people with the link, not search engines; nor one whose team blocked search indexing.
    ...((article.listing === "UNLISTED" || article.noindex) && { robots: { index: false } }),
  };
}

/**
 * A docs page's metadata, with the portal's own Open Graph (its share image and name, from the
 * layout) under the page's: Next.js takes a page's `openGraph` in place of the layout's, not on top.
 */
export async function withPortalOpenGraph(metadata: Metadata, parent: ResolvingMetadata | undefined): Promise<Metadata> {
  if (!metadata.openGraph || !parent) {
    return metadata;
  }
  const portal = (await parent).openGraph;
  return { ...metadata, openGraph: { ...(portal && { siteName: portal.siteName ?? undefined, images: portal.images }), ...metadata.openGraph } };
}

/** A collection's page: its articles, then the collections in it. */
export async function DocsCollectionPage({ page }: { page: Extract<DocsPage, { kind: "collection" }> }) {
  const at = await portalLinks();
  const { docs, tab, parent, collection } = page;
  // The level above: the collection it's in, else its tab or all of them.
  const up = parent ? { href: `/docs/${parent.slug}`, label: parent.name } : allCollections(docs, tab);
  return (
    <DocsLayout tree={docsTree(docs, tab?.slug ?? null, collection.slug)} current={collection.slug}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6">
          <Link href={at(up.href)} className="self-start text-sm font-medium text-primary hover:underline">
            {up.label}
          </Link>
          <PageHeader
            title={
              // Its icon, in the accent colour, before its name.
              <span className="flex items-center gap-3">
                {collection.icon && (
                  <span className="text-primary">
                    <CollectionIcon name={collection.icon} />
                  </span>
                )}
                <span className="min-w-0">{collection.name}</span>
              </span>
            }
            description={collection.description}
          />
        </div>
        {collection.locked ? (
          <LockedMessage signedIn={docs.signedIn} />
        ) : (
          <CollectionContents collection={collection} href={(s) => at(`/docs/${s}`)} collectionHref={(s) => at(`/docs/${s}`)} />
        )}
      </div>
    </DocsLayout>
  );
}

/**
 * Article `slug`'s page (at its own path, or a tab's showing it). A locked one (LockedArticle) has
 * its title, and LockedMessage in place of everything it says.
 */
export async function DocsArticle({
  project,
  slug,
  article,
}: {
  project: string;
  slug: string;
  article: Extract<DocsPage, { kind: "article" }>["article"] | LockedArticle;
}) {
  const at = await portalLinks();
  const readable = "doc" in article ? article : null;
  // Its tab and collection have pages for this reader when they have something to read (an unlisted
  // article may be all there is): the way back is its tab's, or /docs.
  const docs = await docsContents(project);
  const tab = docs.tabs.find((t) => t.slug === article.tab);
  const collection = article.collection && everyCollection(docs.collections).find((c) => c.slug === article.collection!.slug);
  // The tree: its tab's (the first tab's has the articles in none), its collection's branch open.
  const tree = docsTree(docs, article.tab ?? docs.home, article.collection?.slug ?? null);
  const headings = readable ? docHeadings(readable.doc) : [];
  const up = collection ? { href: `/docs/${collection.slug}`, label: collection.name } : allCollections(docs, tab);
  // "Was this helpful?" goes under "On this page" where that shows (wide screens), else under the article.
  const feedback = (beside: boolean, className?: string) => readable && <ArticleFeedback projectSlug={project} slug={slug} beside={beside} className={className} />;
  return (
    <DocsLayout tree={tree} current={slug} headings={headings} beside={feedback(true)}>
      <article className="flex flex-col gap-6" aria-labelledby={ARTICLE_TITLE_ID}>
        <div className="flex flex-col gap-1">
          {/* The actions beside the title on wide screens, under it on phones. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              {/* The level above: its collection (when it has a page for this reader; an unlisted article may be all it has), else its tab or all of them. */}
              <p className="text-sm font-medium text-primary">
                <Link href={at(up.href)} className="hover:underline">
                  {up.label}
                </Link>
              </p>
              <h1 id={ARTICLE_TITLE_ID} className="font-heading text-3xl font-bold tracking-tight break-words">
                {article.title}
              </h1>
            </div>
            {readable && <ArticleActions markdown={await articleMarkdown(readable)} markdownUrl={`${await portalAddress(project)}/docs/${slug}.md`} />}
          </div>
          {readable?.updatedAt && <ArticleUpdated at={readable.updatedAt.toISOString()} label={formatDate(readable.updatedAt)} />}
        </div>
        {readable ? (
          <>
            <RichText doc={readable.doc} mediaUrls={await mediaUrls(readable.doc)} headingIds className="rich-text article-text break-words" />
            <ArticleViewCount projectSlug={project} slug={slug} />
            {feedback(false, outlined(headings) ? "xl:hidden" : undefined)}
          </>
        ) : (
          <LockedMessage signedIn={"signedIn" in article && article.signedIn} />
        )}
      </article>
    </DocsLayout>
  );
}

/** Docs' row under the header: its tabs with something to read (with two or more), `active` the one this page is in. */
export async function DocsTabsRow({ docs, active }: { docs: DocsContents; active: string | null }) {
  const at = await portalLinks();
  const links = docs.tabs.map((tab) => ({ href: at(docsTabPath(docs, tab.slug)), name: tab.name, active: tab.slug === active, locked: tab.locked }));
  return <PartRow label="Docs tabs" links={links} wide />;
}

/**
 * The tab's collections (docsTree): top-level ones always open, the ones in them collapsible
 * (`<details>`, so it works without JavaScript), then the articles in none under "More".
 * `current` is the page's slug (one name per page under /docs), marked as the current page.
 */
async function DocsTree({ tree, current }: { tree: DocsTree; current: string | null }) {
  const at = await portalLinks();
  // One line each, a long name cut short (in full on hover).
  const link = (slug: string, title: string, name: React.ReactNode, className?: string) => (
    <Link
      href={at(`/docs/${slug}`)}
      title={title}
      aria-current={slug === current ? "page" : undefined}
      className={cn(
        "flex items-center rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground",
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
      {locked(collection.name, collection.locked)}
    </>
  );
  // A page's name, with a lock if it's locked for this reader (kept in view when the name is cut short).
  const locked = (name: string, isLocked?: boolean) => (
    <>
      <span className="min-w-0 truncate">{name}</span>
      {isLocked && <LockedMark />}
    </>
  );
  const articles = (list: DocsTree["uncollected"]) => list.map((article) => <li key={article.slug}>{link(article.slug, article.title, locked(article.title, article.locked))}</li>);
  const contents = (collection: DocsTreeCollection) => (
    <ul className="flex flex-col gap-0.5">
      {articles(collection.articles)}
      {collection.collections.map((child) => (
        <li key={child.slug}>
          <details open={child.open}>
            <summary className="flex cursor-pointer list-none items-center rounded-md hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground transition-transform [[open]>summary>&]:rotate-90" />
              {link(child.slug, child.name, named(child), "min-w-0 flex-1 gap-2 pl-1")}
            </summary>
            <div className="ml-3 border-l pl-2">{contents(child)}</div>
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <nav aria-label="Docs" className="flex flex-col gap-5 text-sm">
      <DocsSidebarLinks />
      {tree.collections.map((collection) => (
        <div key={collection.slug} className="flex flex-col gap-1">
          {link(collection.slug, collection.name, named(collection), "gap-2 font-heading font-semibold text-foreground")}
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
 * Every Docs page's columns: the tab's tree on the left (on phones and tablets, in the header's
 * menu instead), the page, and on an article its `headings` on the right ("On this page", on wide
 * screens, with two or more).
 */
/** Whether an article with `headings` gets "On this page" beside it (on wide screens). */
const outlined = (headings: Heading[]) => headings.length >= 2;

export function DocsLayout({
  tree,
  current,
  headings = [],
  beside,
  children,
}: {
  /** Null for none (a tab's overview, whose cards are its collections). */
  tree: DocsTree | null;
  current: string | null;
  headings?: Heading[];
  /** Under "On this page" (shown from wide screens with two headings or more; see `outlined`). */
  beside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const shown = tree && (tree.collections.length > 0 || tree.uncollected.length > 0) ? tree : null;
  return (
    <div className="flex gap-10">
      {/* From the header to the footer, with a line beside it; the tree scrolls on its own, under the header. */}
      {shown && (
        <aside className="-my-10 hidden w-72 shrink-0 border-r md:block">
          <div className="sticky top-[var(--portal-header-height,0px)] max-h-[calc(100dvh-var(--portal-header-height,0px))] overflow-y-auto py-10 pr-4 [scrollbar-width:thin]">
            <DocsTree tree={shown} current={current} />
          </div>
        </aside>
      )}
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
        {shown && (
          <>
            {/* On phones and tablets the tree is in the header's menu; without JavaScript (no menu), above the page. */}
            <PortalMenuPart>
              <DocsTree tree={shown} current={current} />
            </PortalMenuPart>
            <noscript>
              <details className="rounded-xl border md:hidden">
                <summary className="cursor-pointer px-4 py-2 text-sm font-medium">Browse docs</summary>
                <div className="border-t p-2">
                  <DocsTree tree={shown} current={current} />
                </div>
              </details>
            </noscript>
          </>
        )}
        {children}
        <PortalFooter docs />
      </div>
      {outlined(headings) && (
        <aside className="hidden w-64 shrink-0 xl:block">
          {/* Stays in view as the article scrolls, under the header. */}
          <div className="sticky top-[calc(var(--portal-header-height,0px)+1.5rem)] flex max-h-[calc(100dvh-var(--portal-header-height,0px)-3rem)] flex-col gap-6 overflow-y-auto">
            <OnThisPage headings={headings} />
            {beside}
          </div>
        </aside>
      )}
    </div>
  );
}
