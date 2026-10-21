import type { Heading } from "@tuti/content";
import { prisma } from "@tuti/db";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { DocsCollections } from "@/components/docs-collections";
import { PageHeader } from "@/components/page-header";
import { PartRow } from "@/components/portal-nav";
import { buttonVariants } from "@/components/ui/button";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { type DocsContents, type DocsTabView, type DocsTree, type DocsTreeCollection, docsTabPath } from "@/server/docs-queries";
import { searchDocs } from "@/server/docs-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { readerGroups } from "@/server/portal-access";
import { portalLinks } from "@/server/portal-base";

/** Published articles matching `query`, each with the passage that matched. */
async function SearchResults({ projectSlug, query }: { projectSlug: string; query: string }) {
  const at = await portalLinks();
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  const results = project ? await searchDocs(project.id, query, 10, await readerGroups(project.id)) : [];
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

/**
 * /docs and a tab's page: each collection with its published articles, then the articles in none,
 * or, for a search (`?q=` on /docs, over every tab; the box is in the header), its results. With
 * tabs, the one shown (`tab`), with its collections; the first also has the articles in none. (The
 * row of tabs is DocsTabsRow, under the header.)
 */
export async function DocsIndex({ projectSlug, query, docs, tab }: { projectSlug: string; query: string; docs: DocsContents; tab: DocsTabView | null }) {
  const at = await portalLinks();
  // Search results stand alone.
  const { collections, uncollected } = query ? { collections: [], uncollected: [] } : (tab ?? docs);
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Docs" description="Guides and answers to common questions." />
      {query && answersEnabled() && (
        <DocsAnswer
          key={query}
          projectSlug={projectSlug}
          question={query}
          feedbackHref={await feedbackHref(projectSlug, query)}
          askAPerson={await askAPerson(projectSlug)}
        />
      )}
      {query && <SearchResults projectSlug={projectSlug} query={query} />}
      {!query && collections.length === 0 && uncollected.length === 0 && (
        <EmptyState title="Nothing here yet" description="Articles show up here once they're published." />
      )}
      <DocsCollections
        collections={collections}
        uncollected={uncollected}
        href={(article) => at(`/docs/${article}`)}
        collectionHref={(collection) => at(`/docs/${collection}`)}
      />
    </div>
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
