import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { DocsCollections, DocsTabs } from "@/components/docs-collections";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { docsContents, publishedArticle } from "@/server/docs-queries";
import { searchDocs } from "@/server/docs-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { readerGroups } from "@/server/portal-access";

/** A widget Docs URL: the list (with the search, if any, or in a docs tab) or an article. */
function docsHref(query: string, article?: string, docsTab?: string) {
  const params = new URLSearchParams({ tab: "docs" });
  if (query) {
    params.set("q", query);
  }
  if (docsTab) {
    params.set("docsTab", docsTab);
  }
  if (article) {
    params.set("article", article);
  }
  return `/widget?${params}`;
}

/**
 * The widget's Docs tab: the portal's docs at panel size. A search (`q`) with the
 * portal's "Ask AI", the collections with their articles, or one article (`article`), which
 * also opens on the portal in a new tab. Article links keep the search, so going back
 * returns to the results. "Post this as feedback" opens the widget's own Feedback tab; "Ask a person"
 * works as on the portal.
 */
export async function WidgetDocs({
  projectId,
  projectSlug,
  query,
  article,
  docsTab,
  hasBoard,
}: {
  projectId: string;
  projectSlug: string;
  query: string;
  article?: string;
  /** The docs tab the list shows, or the article was opened from. */
  docsTab?: string;
  /** Whether the Feedback tab can take a post (the project has a board). */
  hasBoard: boolean;
}) {
  if (article) {
    return (
      <WidgetArticle
        projectSlug={projectSlug}
        slug={article}
        back={docsHref(query, undefined, query ? undefined : docsTab)}
        backLabel={query ? "Search results" : "All articles"}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {/* A plain GET form: search works without JavaScript. */}
      <form role="search" action="/widget" className="flex gap-2">
        <input type="hidden" name="tab" value="docs" />
        <Input type="search" name="q" defaultValue={query} maxLength={200} placeholder="Search articles" aria-label="Search the docs" />
        <Button type="submit">Search</Button>
      </form>
      {query && answersEnabled() && (
        <DocsAnswer
          key={query}
          widget
          projectSlug={projectSlug}
          question={query}
          feedbackHref={hasBoard ? `/widget?${new URLSearchParams({ title: query.slice(0, MAX_POST_TITLE) })}` : null}
          askAPerson={await askAPerson(projectSlug)}
        />
      )}
      {query ? <SearchResults projectId={projectId} query={query} /> : <Collections projectSlug={projectSlug} docsTab={docsTab} />}
    </div>
  );
}

async function SearchResults({ projectId, query }: { projectId: string; query: string }) {
  const results = await searchDocs(projectId, query, 10, await readerGroups(projectId));
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No articles match “${query}”`}
        description="Try other words, or browse all articles."
        action={
          <Link href={docsHref("")} className={buttonVariants({ variant: "outline" })}>
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
          <Link href={docsHref(query, result.slug)} className="break-words text-primary hover:underline">
            {result.title}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Like the portal's /docs: each collection with its published articles and the collections in it,
 * then the articles in none; with tabs, the first by default.
 */
async function Collections({ projectSlug, docsTab }: { projectSlug: string; docsTab?: string }) {
  const docs = await docsContents(projectSlug);
  const tab = docs.tabs.find((t) => t.slug === docsTab) ?? docs.tabs[0];
  const { collections, uncollected } = tab ?? docs;
  return (
    <>
      {tab && <DocsTabs tabs={docs.tabs} active={tab.slug} href={(t) => docsHref("", undefined, t)} compact />}
      <DocsCollections collections={collections} uncollected={uncollected} href={(slug) => docsHref("", slug, tab?.slug)} compact />
    </>
  );
}

async function WidgetArticle({ projectSlug, slug, back, backLabel }: { projectSlug: string; slug: string; back: string; backLabel: string }) {
  const article = await publishedArticle(projectSlug, slug);
  if (!article) {
    return (
      <EmptyState
        title="Article not found"
        description="It may have been moved or unpublished."
        action={
          <Link href={back} className={buttonVariants({ variant: "outline" })}>
            {backLabel}
          </Link>
        }
      />
    );
  }
  return (
    <article className="flex flex-col gap-4" aria-labelledby="article-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackLink href={back}>{backLabel}</BackLink>
        <Link
          href={`/docs/${slug}`}
          target="_blank"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&>svg]:size-4"
        >
          Open in new tab
          <ExternalLinkIcon aria-hidden />
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        {article.collection && <p className="text-sm text-muted-foreground">{article.collection.name}</p>}
        <h1 id="article-title" className="font-heading text-xl font-bold tracking-tight break-words">
          {article.title}
        </h1>
      </div>
      <RichText doc={article.doc} mediaBaseUrl={mediaPublicUrl()} className="rich-text break-words" />
    </article>
  );
}
