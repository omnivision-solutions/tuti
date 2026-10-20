import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { HelpAnswer } from "@/components/help-answer";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { helpCenter, publishedArticle } from "@/server/help-queries";
import { searchHelp } from "@/server/help-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/help-ask";

/** A widget Help URL: the list (with the search, if any) or an article. */
function helpHref(query: string, article?: string) {
  const params = new URLSearchParams({ tab: "help" });
  if (query) {
    params.set("q", query);
  }
  if (article) {
    params.set("article", article);
  }
  return `/widget?${params}`;
}

/**
 * The widget's Help tab: the portal's help center at panel size. A search (`q`) with the
 * portal's "Ask AI", the collections with their articles, or one article (`article`), which
 * also opens on the portal in a new tab. Article links keep the search, so going back
 * returns to the results. "Post this as feedback" opens the widget's own Feedback tab.
 */
export async function WidgetHelp({
  projectId,
  projectSlug,
  query,
  article,
  hasBoard,
}: {
  projectId: string;
  projectSlug: string;
  query: string;
  article?: string;
  /** Whether the Feedback tab can take a post (the project has a board). */
  hasBoard: boolean;
}) {
  if (article) {
    return <WidgetArticle projectSlug={projectSlug} slug={article} back={helpHref(query)} backLabel={query ? "Search results" : "All articles"} />;
  }
  return (
    <div className="flex flex-col gap-6">
      {/* A plain GET form: search works without JavaScript. */}
      <form role="search" action="/widget" className="flex gap-2">
        <input type="hidden" name="tab" value="help" />
        <Input type="search" name="q" defaultValue={query} maxLength={200} placeholder="Search articles" aria-label="Search the help center" />
        <Button type="submit">Search</Button>
      </form>
      {query && answersEnabled() && (
        <HelpAnswer
          key={query}
          widget
          projectSlug={projectSlug}
          question={query}
          feedbackHref={hasBoard ? `/widget?${new URLSearchParams({ title: query.slice(0, MAX_POST_TITLE) })}` : null}
        />
      )}
      {query ? <SearchResults projectId={projectId} query={query} /> : <Collections projectSlug={projectSlug} />}
    </div>
  );
}

async function SearchResults({ projectId, query }: { projectId: string; query: string }) {
  const results = await searchHelp(projectId, query, 10);
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No articles match “${query}”`}
        description="Try other words, or browse all articles."
        action={
          <Link href={helpHref("")} className={buttonVariants({ variant: "outline" })}>
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
          <Link href={helpHref(query, result.slug)} className="break-words text-primary hover:underline">
            {result.title}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

function ArticleLinks({ articles }: { articles: { slug: string; title: string }[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {articles.map((article) => (
        <li key={article.slug}>
          <Link href={helpHref("", article.slug)} className="break-words text-primary hover:underline">
            {article.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Like the portal's /help: each collection with its published articles, then the articles in none. */
async function Collections({ projectSlug }: { projectSlug: string }) {
  const { collections, uncollected } = await helpCenter(projectSlug);
  return (
    <>
      {collections.map((collection) => (
        <section key={collection.slug} aria-labelledby={`collection-${collection.slug}`} className="flex flex-col gap-2">
          <h2 id={`collection-${collection.slug}`} className="font-heading font-bold tracking-tight break-words">
            {collection.name}
          </h2>
          {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
          <ArticleLinks articles={collection.articles} />
        </section>
      ))}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className="font-heading font-bold tracking-tight">
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} />
        </section>
      )}
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
          href={`/help/${slug}`}
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
