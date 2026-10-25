import { cn } from "cn";
import { ChevronRightIcon, FolderIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

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

/** A link as a row of a collection's card: an icon, its name, and a chevron. */
function Row({ href, icon, children }: { href: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent">
        {icon}
        <span className="min-w-0 flex-1 break-words">{children}</span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

const card = "rounded-xl border bg-card text-card-foreground";

/** Rows for `articles`, then for `collections` (each opens its own page, with a folder icon or its own). */
function Rows({
  articles,
  collections = [],
  href,
  collectionHref,
  label,
}: {
  articles: Articles;
  collections?: DocsCollection[];
  href: (slug: string) => string;
  collectionHref: (slug: string) => string;
  label?: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-col p-1.5">
      {articles.map((article) => (
        <Row key={article.slug} href={href(article.slug)}>
          {article.title}
          {article.locked && <LockedMark />}
        </Row>
      ))}
      {collections.map((child) => (
        <Row
          key={child.slug}
          href={collectionHref(child.slug)}
          icon={<span className="text-muted-foreground">{child.icon ? <CollectionIcon name={child.icon} /> : <FolderIcon aria-hidden className="size-[1.25em]" />}</span>}
        >
          {child.name}
          {child.locked && <LockedMark />}
        </Row>
      ))}
    </ul>
  );
}

/**
 * A collection's page: a card of its articles, then a card for each collection in it (its name as
 * the card's h2, then its articles and, as folders, the collections in it, each opening its own page).
 */
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
      {collection.articles.length > 0 && (
        <div className={card}>
          <Rows label="Articles" articles={collection.articles} href={href} collectionHref={collectionHref} />
        </div>
      )}
      {collection.collections.map((child) => (
        <section key={child.slug} aria-labelledby={`collection-${child.slug}`} className={card}>
          <div className="flex flex-col gap-0.5 border-b px-4.5 py-3">
            <h2 id={`collection-${child.slug}`} className="flex items-center gap-2 font-medium break-words">
              <Link href={collectionHref(child.slug)} className="min-w-0 hover:underline">
                {child.name}
                {child.locked && <LockedMark />}
              </Link>
            </h2>
            {child.description && <p className="text-sm text-muted-foreground">{child.description}</p>}
          </div>
          {child.articles.length + child.collections.length > 0 && (
            <Rows articles={child.articles} collections={child.collections} href={href} collectionHref={collectionHref} />
          )}
        </section>
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
