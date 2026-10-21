import { cn } from "cn";
import { LockIcon } from "lucide-react";
import Link from "next/link";

import { CollectionIcon } from "@/components/collection-icon";
import type { DocsArticleLink, DocsCollection } from "@/server/docs-queries";

type Articles = DocsArticleLink[];

/** After the title of a page this reader may not read: a lock, "Locked" to screen readers. */
export function LockedMark({ className }: { className?: string }) {
  return (
    <>
      <LockIcon aria-hidden className={cn("ml-1.5 inline-block size-3.5 shrink-0 align-[-0.1em] text-muted-foreground", className)} />
      <span className="sr-only"> Locked</span>
    </>
  );
}

export function ArticleLinks({ articles, href }: { articles: Articles; href: (slug: string) => string }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {articles.map((article) => (
        <li key={article.slug}>
          <Link href={href(article.slug)} className="break-words text-primary hover:underline">
            {article.title}
            {article.locked && <LockedMark />}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A collection: its heading (h2 at `level` 2, a level down for each one it's in; past h6, bold
 * text), its articles, then the collections in it.
 */
function CollectionSection({
  collection,
  level,
  href,
  collectionHref,
}: {
  collection: DocsCollection;
  level: number;
  href: (slug: string) => string;
  collectionHref: (slug: string) => string;
}) {
  const Heading = level <= 6 ? (`h${level}` as "h2") : "p";
  return (
    <section aria-labelledby={`collection-${collection.slug}`} className="flex flex-col gap-2">
      <Heading
        id={`collection-${collection.slug}`}
        className={cn("flex items-center gap-2 font-heading font-bold tracking-tight break-words", level === 2 && "text-lg")}
      >
        <CollectionIcon name={collection.icon} />
        <Link href={collectionHref(collection.slug)} className="min-w-0 hover:underline">
          {collection.name}
          {collection.locked && <LockedMark />}
        </Link>
      </Heading>
      {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
      {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={href} />}
      {collection.collections.length > 0 && (
        <div className="mt-2 flex flex-col gap-4 border-l pl-4">
          {collection.collections.map((child) => (
            <CollectionSection key={child.slug} collection={child} level={level + 1} href={href} collectionHref={collectionHref} />
          ))}
        </div>
      )}
    </section>
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
        <CollectionSection key={child.slug} collection={child} level={2} href={href} collectionHref={collectionHref} />
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
  tabs: { slug: string; name: string; locked?: true }[];
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
          {tab.locked && <LockedMark className="text-current" />}
        </Link>
      ))}
    </nav>
  );
}
