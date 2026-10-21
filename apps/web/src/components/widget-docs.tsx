import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { BackLink } from "@/components/back-link";
import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { DocsAnswer } from "@/components/docs-answer";
import { ArticleLinks, DocsTabs, LockedMark } from "@/components/docs-collections";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WidgetLocked } from "@/components/widget-locked";
import { type DocsCollection, docsContents, findCollection, lockedForReader, movedArticle, publishedArticle } from "@/server/docs-queries";
import { searchForReader } from "@/server/docs-search";
import { MAX_POST_TITLE } from "@/server/operations/create";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";

/**
 * What a page this reader may not read, but sees with a lock, says in the panel: to sign in (as
 * for a private portal; the customer's page can sign them in here), or that they don't have access.
 */
function LockedMessage({ projectSlug, signedIn }: { projectSlug: string; signedIn: boolean }) {
  return signedIn ? <p className="text-sm text-muted-foreground">You don&apos;t have access to this.</p> : <WidgetLocked projectSlug={projectSlug} />;
}

/** A widget Docs URL: the list (with the search, if any, or in a docs tab, or a collection's) or an article (opened from there). */
function docsHref({ q, docsTab, collection, article }: { q?: string; docsTab?: string; collection?: string; article?: string }) {
  const params = new URLSearchParams({ tab: "docs" });
  for (const [key, value] of Object.entries({ q, docsTab, collection, article })) {
    if (value) {
      params.set(key, value);
    }
  }
  return `/widget?${params}`;
}

/**
 * The widget's Docs tab: the portal's docs at panel size. A search (`q`) with the
 * portal's "Ask AI", the docs a level at a time (the collections and the articles in none, or
 * a collection's, `collection`), or one article (`article`), which also opens on the portal in
 * a new tab. Article links keep the search or the collection, so going back returns there. "Post this as feedback" opens the widget's own Feedback tab; "Ask a person"
 * works as on the portal.
 */
export async function WidgetDocs({
  projectId,
  projectSlug,
  query,
  article,
  docsTab,
  collection,
  hasBoard,
}: {
  projectId: string;
  projectSlug: string;
  query: string;
  article?: string;
  /** The docs tab the list shows, or the article was opened from. */
  docsTab?: string;
  /** The collection the list shows, or the article was opened from. */
  collection?: string;
  /** Whether the Feedback tab can take a post (the project has a board). */
  hasBoard: boolean;
}) {
  if (article) {
    return (
      <WidgetArticle
        projectSlug={projectSlug}
        slug={article}
        back={docsHref(query ? { q: query } : { docsTab, collection })}
        backLabel={query ? "Search results" : "All articles"}
        from={query ? undefined : collection}
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
      {query ? (
        <SearchResults projectId={projectId} projectSlug={projectSlug} query={query} />
      ) : (
        <Collections projectSlug={projectSlug} docsTab={docsTab} collection={collection} />
      )}
    </div>
  );
}

async function SearchResults({ projectId, projectSlug, query }: { projectId: string; projectSlug: string; query: string }) {
  const results = await searchForReader(projectId, projectSlug, query, 10);
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No articles match “${query}”`}
        description="Try other words, or browse all articles."
        action={
          <Link href={docsHref({})} className={buttonVariants({ variant: "outline" })}>
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
          <Link href={docsHref({ q: query, article: result.slug })} className="break-words text-primary hover:underline">
            {result.title}
            {result.locked && <LockedMark />}
          </Link>
          {result.snippet && <p className="text-sm break-words text-muted-foreground">{result.snippet}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Collections as links that open them, each with its description. */
function CollectionLinks({ collections, label, href }: { collections: DocsCollection[]; label: string; href: (slug: string) => string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {collections.map((collection) => (
        <li key={collection.slug} className="flex flex-col gap-0.5">
          <Link href={href(collection.slug)} className="flex items-center gap-2 font-medium hover:underline">
            <CollectionIcon name={collection.icon} />
            <span className="min-w-0 break-words">
              {collection.name}
              {collection.locked && <LockedMark />}
            </span>
          </Link>
          {collection.description && <p className="text-sm break-words text-muted-foreground">{collection.description}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The portal's docs a level at a time, so any depth fits the panel: with tabs, the first by
 * default; the tab's collections (each opens its own list) and, on the first, the articles in
 * none. A collection's list (`collection`): the way back, its articles, then the collections in it.
 */
async function Collections({ projectSlug, docsTab, collection: slug }: { projectSlug: string; docsTab?: string; collection?: string }) {
  const docs = await docsContents(projectSlug);
  // One this reader may read, else the top level.
  const found = slug ? findCollection(docs, slug) : null;
  const tab = found ? found.tab : (docs.tabs.find((t) => t.slug === docsTab) ?? docs.tabs[0]);
  const at = { docsTab: tab?.slug };
  const tabs = tab && <DocsTabs tabs={docs.tabs} active={tab.slug} href={(t) => docsHref({ docsTab: t })} compact />;
  if (found) {
    const { collection, parent } = found;
    return (
      <>
        {tabs}
        <div className="flex flex-col gap-2">
          <BackLink href={docsHref(parent ? { ...at, collection: parent.slug } : at)}>{parent ? parent.name : "All articles"}</BackLink>
          <h2 className="flex items-center gap-2 font-heading text-lg font-bold tracking-tight break-words">
            <CollectionIcon name={collection.icon} />
            <span className="min-w-0">{collection.name}</span>
          </h2>
          {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
        </div>
        {collection.locked && <LockedMessage projectSlug={projectSlug} signedIn={docs.signedIn} />}
        {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={(article) => docsHref({ ...at, collection: collection.slug, article })} />}
        {collection.collections.length > 0 && (
          <CollectionLinks
            collections={collection.collections}
            label={`Collections in ${collection.name}`}
            href={(child) => docsHref({ ...at, collection: child })}
          />
        )}
      </>
    );
  }
  const { collections, uncollected } = tab ?? docs;
  return (
    <>
      {tabs}
      {tab?.locked && <LockedMessage projectSlug={projectSlug} signedIn={docs.signedIn} />}
      {collections.length > 0 && <CollectionLinks collections={collections} label="Collections" href={(c) => docsHref({ ...at, collection: c })} />}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className="font-heading font-bold tracking-tight">
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} href={(article) => docsHref({ ...at, article })} />
        </section>
      )}
    </>
  );
}

async function WidgetArticle({
  projectSlug,
  slug: asked,
  back,
  backLabel,
  from,
}: {
  projectSlug: string;
  slug: string;
  back: string;
  backLabel: string;
  /** The collection it was opened from: the way back is named after it. */
  from?: string;
}) {
  // An old slug of an article that has since moved opens it where it is now.
  const moved = (await publishedArticle(projectSlug, asked)) ? null : await movedArticle(projectSlug, asked);
  const slug = moved ?? asked;
  // One locked for this reader: its title, and what to do.
  const article = (await publishedArticle(projectSlug, slug)) ?? (await lockedForReader(projectSlug, slug));
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
        <BackLink href={back}>{from && article.collection?.slug === from ? article.collection.name : backLabel}</BackLink>
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
      {"doc" in article ? (
        <RichText doc={article.doc} mediaBaseUrl={mediaPublicUrl()} className="rich-text break-words" />
      ) : (
        <LockedMessage projectSlug={projectSlug} signedIn={article.signedIn} />
      )}
    </article>
  );
}
