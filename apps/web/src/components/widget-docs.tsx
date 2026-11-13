import { RichText } from "@tuti/content/react";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { articleLinks } from "@/components/article-links";
import { BackLink } from "@/components/back-link";
import { CollectionIcon } from "@/components/collection-icon";
import { EmptyState } from "@/components/empty-state";
import { ArticleLinks, LockedMark } from "@/components/docs-collections";
import { FilterPills } from "@/components/filter-pills";
import { buttonVariants } from "@/components/ui/button";
import { WidgetDocsSearch, WidgetNoResults, WidgetSearchResults } from "@/components/widget-docs-search";
import { WidgetLocked } from "@/components/widget-locked";
import { WIDGET_LABEL, WIDGET_ROW, WIDGET_TILE } from "@/lib/portal-look";
import { cn } from "@/lib/utils";
import { docsHref } from "@/lib/widget-docs";
import { articleCount, type DocsCollection, docsContents, findCollection, lockedForReader, movedArticle, publishedArticle } from "@/server/docs-queries";
import { searchForReader } from "@/server/docs-search";
import { mediaUrls } from "@/server/media-urls";
import { portalHref, portalLinks } from "@/server/portal-base";

/**
 * What a page this reader may not read, but sees with a lock, says in the panel: to sign in (as
 * for a private portal; the customer's page can sign them in here), or that they don't have access.
 */
function LockedMessage({ projectSlug, signedIn }: { projectSlug: string; signedIn: boolean }) {
  return signedIn ? <p className="text-sm text-muted-foreground">You don&apos;t have access to this.</p> : <WidgetLocked projectSlug={projectSlug} />;
}

/**
 * The widget's Docs tab: the portal's docs at panel size. A search (`q`, with results as the reader
 * types: components/widget-docs-search.tsx), with "Ask AI" for it in the assistant
 * (components/docs-assistant.tsx, which the page puts around the panel), the docs a level at a time (the collections and the articles in none, or
 * a collection's, `collection`), or one article (`article`), which also opens on the portal in
 * a new tab. Article links keep the search or the collection, so going back returns there.
 */
export async function WidgetDocs({
  projectId,
  projectSlug,
  query,
  article,
  docsTab,
  collection,
}: {
  projectId: string;
  projectSlug: string;
  query: string;
  article?: string;
  /** The docs tab the list shows, or the article was opened from. */
  docsTab?: string;
  /** The collection the list shows, or the article was opened from. */
  collection?: string;
}) {
  if (article) {
    const link = await portalLinks();
    return (
      <WidgetArticle
        projectSlug={projectSlug}
        slug={article}
        back={link(docsHref(query ? { q: query } : { docsTab, collection }))}
        backLabel={query ? "Search results" : "All articles"}
        from={query ? undefined : collection}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <WidgetDocsSearch query={query}>
        {query ? (
          <SearchResults projectId={projectId} projectSlug={projectSlug} query={query} />
        ) : (
          <Collections projectSlug={projectSlug} docsTab={docsTab} collection={collection} />
        )}
      </WidgetDocsSearch>
    </div>
  );
}

async function SearchResults({ projectId, projectSlug, query }: { projectId: string; projectSlug: string; query: string }) {
  const results = await searchForReader(projectId, projectSlug, query, 10);
  return results.length === 0 ? <WidgetNoResults query={query} /> : <WidgetSearchResults query={query} results={results} />;
}

/**
 * Collections as rows that open them, each with its icon on a neutral tile, its description and how many articles
 * this reader may open in it (none in a locked one, which shows nothing), as the portal's docs count them.
 */
function CollectionLinks({ collections, label, href }: { collections: DocsCollection[]; label: string; href: (slug: string) => string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y">
      {collections.map((collection) => {
        const count = articleCount(collection);
        return (
          <li key={collection.slug}>
            <Link href={href(collection.slug)} className={WIDGET_ROW}>
              <span className={cn(WIDGET_TILE, "empty:hidden")}>
                <CollectionIcon name={collection.icon} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">
                  {collection.name}
                  {collection.locked && <LockedMark />}
                </span>
                {collection.description && <span className="text-sm break-words text-muted-foreground">{collection.description}</span>}
                {count > 0 && <span className="text-xs text-muted-foreground">{count === 1 ? "1 article" : `${count} articles`}</span>}
              </span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The portal's docs a level at a time, so any depth fits the panel: with tabs, the first by
 * default; the tab's collections (each opens its own list) and, on the first, the articles in
 * none. A collection's list (`collection`): the way back, its articles, then the collections in it.
 */
async function Collections({ projectSlug, docsTab, collection: slug }: { projectSlug: string; docsTab?: string; collection?: string }) {
  const [docs, link] = await Promise.all([docsContents(projectSlug), portalLinks()]);
  // One this reader may read, else the top level.
  const found = slug ? findCollection(docs, slug) : null;
  const tab = found ? found.tab : (docs.tabs.find((t) => t.slug === docsTab) ?? docs.tabs[0]);
  const at = { docsTab: tab?.slug };
  // With two or more, the docs' tabs as the portal's pills, the open one the neutral fill.
  const tabs = tab && docs.tabs.length > 1 && (
    <FilterPills
      label="Docs tabs"
      current={link(docsHref({ docsTab: tab.slug }))}
      items={docs.tabs.map((t) => ({
        href: link(docsHref({ docsTab: t.slug })),
        title: (
          <>
            {t.name}
            {t.locked && <LockedMark className="ml-0 text-current" />}
          </>
        ),
      }))}
    />
  );
  if (found) {
    const { collection, parent } = found;
    return (
      <>
        {tabs}
        <div className="flex flex-col gap-2">
          <BackLink href={link(docsHref(parent ? { ...at, collection: parent.slug } : at))}>{parent ? parent.name : "All articles"}</BackLink>
          <h2 className="flex items-center gap-2 font-heading text-lg font-bold tracking-tight break-words">
            <CollectionIcon name={collection.icon} />
            <span className="min-w-0">{collection.name}</span>
          </h2>
          {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
        </div>
        {collection.locked && <LockedMessage projectSlug={projectSlug} signedIn={docs.signedIn} />}
        {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={(article) => link(docsHref({ ...at, collection: collection.slug, article }))} />}
        {collection.collections.length > 0 && (
          <CollectionLinks
            collections={collection.collections}
            label={`Collections in ${collection.name}`}
            href={(child) => link(docsHref({ ...at, collection: child }))}
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
      {collections.length > 0 && <CollectionLinks collections={collections} label="Collections" href={(c) => link(docsHref({ ...at, collection: c }))} />}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className={WIDGET_LABEL}>
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} href={(article) => link(docsHref({ ...at, article }))} />
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
  const link = await portalLinks();
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
          href={await portalHref(`/docs/${slug}`)}
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
        <RichText
          doc={article.doc}
          mediaUrls={await mediaUrls(article.doc)}
          headingIds
          // Its links to the portal's other articles open them here in the panel; to its other docs pages, on the portal.
          link={await articleLinks(projectSlug, article.doc, ({ slug, hash, article: isArticle }) => (isArticle ? `${link(docsHref({ article: slug }))}${hash}` : null))}
          className="rich-text break-words"
        />
      ) : (
        <LockedMessage projectSlug={projectSlug} signedIn={article.signedIn} />
      )}
    </article>
  );
}
