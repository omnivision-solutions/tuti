import { prisma } from "@tuti/db";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { DocsCollections, DocsTabs } from "@/components/docs-collections";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { boardPath } from "@/lib/post-urls";
import { type DocsContents, type DocsTabView, docsTabPath } from "@/server/docs-queries";
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
 * /docs and a tab's page: a search box (`?q=` on /docs, over every tab), then each collection with
 * its published articles, then the articles in none. With tabs, the row of them and the one shown
 * (`tab`), with its collections; the first also has the articles in none.
 */
export async function DocsIndex({ projectSlug, query, docs, tab }: { projectSlug: string; query: string; docs: DocsContents; tab: DocsTabView | null }) {
  const at = await portalLinks();
  const { collections, uncollected } = tab ?? docs;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Docs" description="Guides and answers to common questions." />
      {/* A plain GET form: search works without JavaScript. */}
      <form role="search" action={at("/docs")} className="flex gap-2">
        <Input type="search" name="q" defaultValue={query} maxLength={200} placeholder="Search articles" aria-label="Search the docs" />
        <Button type="submit">Search</Button>
      </form>
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
      {tab && <DocsTabs tabs={docs.tabs} active={tab.slug} href={(t) => at(docsTabPath(docs, t))} />}
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
