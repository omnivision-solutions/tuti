import { cn } from "cn";
import Link from "next/link";

import type { DocsCollection } from "@/server/docs-queries";

type Articles = { slug: string; title: string }[];

function ArticleLinks({ articles, href }: { articles: Articles; href: (slug: string) => string }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {articles.map((article) => (
        <li key={article.slug}>
          <Link href={href(article.slug)} className="break-words text-primary hover:underline">
            {article.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A collection's link, on the portal: its own page. */
type CollectionHref = ((slug: string) => string) | undefined;

/** A collection: its heading (h2 at the top level, h3 inside another), its articles, then the collections in it. */
function CollectionSection({
  collection,
  nested,
  href,
  collectionHref,
  compact,
}: {
  collection: DocsCollection;
  nested: boolean;
  href: (slug: string) => string;
  collectionHref: CollectionHref;
  compact: boolean;
}) {
  const Heading = nested ? "h3" : "h2";
  return (
    <section aria-labelledby={`collection-${collection.slug}`} className="flex flex-col gap-2">
      <Heading
        id={`collection-${collection.slug}`}
        className={cn("font-heading font-bold tracking-tight break-words", !nested && !compact && "text-lg")}
      >
        {collectionHref ? (
          <Link href={collectionHref(collection.slug)} className="hover:underline">
            {collection.name}
          </Link>
        ) : (
          collection.name
        )}
      </Heading>
      {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
      {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={href} />}
      {collection.collections.length > 0 && (
        <div className="mt-2 flex flex-col gap-4 border-l pl-4">
          {collection.collections.map((child) => (
            <CollectionSection key={child.slug} collection={child} nested href={href} collectionHref={collectionHref} compact={compact} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The docs' contents, for the portal's /docs and the widget's Docs tab: each collection in
 * order with its articles and the collections in it, then the articles in none.
 */
export function DocsCollections({
  collections,
  uncollected,
  href,
  collectionHref,
  compact = false,
}: {
  collections: DocsCollection[];
  uncollected: Articles;
  /** An article's link. */
  href: (slug: string) => string;
  /** A collection's link (the widget's are headings only). */
  collectionHref?: CollectionHref;
  /** Smaller headings, for the widget's panel. */
  compact?: boolean;
}) {
  return (
    <>
      {collections.map((collection) => (
        <CollectionSection key={collection.slug} collection={collection} nested={false} href={href} collectionHref={collectionHref} compact={compact} />
      ))}
      {uncollected.length > 0 && (
        <section aria-labelledby={collections.length > 0 ? "more-articles" : undefined} className="flex flex-col gap-2">
          {collections.length > 0 && (
            <h2 id="more-articles" className={cn("font-heading font-bold tracking-tight", !compact && "text-lg")}>
              More articles
            </h2>
          )}
          <ArticleLinks articles={uncollected} href={href} />
        </section>
      )}
    </>
  );
}

/** A collection's page: its articles, then the collections in it (each with its own). */
export function CollectionContents({
  collection,
  href,
  collectionHref,
}: {
  collection: DocsCollection;
  href: (slug: string) => string;
  collectionHref: (slug: string) => string;
}) {
  return (
    <>
      {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={href} />}
      {collection.collections.map((child) => (
        <CollectionSection key={child.slug} collection={child} nested={false} href={href} collectionHref={collectionHref} compact={false} />
      ))}
    </>
  );
}

/**
 * The docs' tabs, above its collections (only with two or more). `href` links a tab; plain
 * links, so they work without JavaScript.
 */
export function DocsTabs({
  tabs,
  active,
  href,
  compact = false,
}: {
  tabs: { slug: string; name: string }[];
  /** The tab whose page (or collection or article) this is, if any. */
  active: string | null;
  href: (slug: string) => string;
  compact?: boolean;
}) {
  if (tabs.length < 2) {
    return null;
  }
  return (
    <nav aria-label="Docs tabs" className="flex gap-1 overflow-x-auto">
      {tabs.map((tab) => (
        <Link
          key={tab.slug}
          href={href(tab.slug)}
          aria-current={tab.slug === active ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 whitespace-nowrap transition-colors",
            compact ? "text-xs" : "text-sm",
            tab.slug === active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {tab.name}
        </Link>
      ))}
    </nav>
  );
}
