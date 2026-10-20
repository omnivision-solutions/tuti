import { cn } from "cn";
import Link from "next/link";

import type { HelpCollection } from "@/server/help-queries";

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

/** A collection: its heading (h2 at the top level, h3 inside another), its articles, then the collections in it. */
function CollectionSection({
  collection,
  nested,
  href,
  compact,
}: {
  collection: HelpCollection;
  nested: boolean;
  href: (slug: string) => string;
  compact: boolean;
}) {
  const Heading = nested ? "h3" : "h2";
  return (
    <section aria-labelledby={`collection-${collection.slug}`} className="flex flex-col gap-2">
      <Heading
        id={`collection-${collection.slug}`}
        className={cn("font-heading font-bold tracking-tight break-words", !nested && !compact && "text-lg")}
      >
        {collection.name}
      </Heading>
      {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}
      {collection.articles.length > 0 && <ArticleLinks articles={collection.articles} href={href} />}
      {collection.collections.length > 0 && (
        <div className="mt-2 flex flex-col gap-4 border-l pl-4">
          {collection.collections.map((child) => (
            <CollectionSection key={child.slug} collection={child} nested href={href} compact={compact} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The help center's contents, for the portal's /help and the widget's Help tab: each collection in
 * order with its articles and the collections in it, then the articles in none.
 */
export function HelpCollections({
  collections,
  uncollected,
  href,
  compact = false,
}: {
  collections: HelpCollection[];
  uncollected: Articles;
  /** An article's link. */
  href: (slug: string) => string;
  /** Smaller headings, for the widget's panel. */
  compact?: boolean;
}) {
  return (
    <>
      {collections.map((collection) => (
        <CollectionSection key={collection.slug} collection={collection} nested={false} href={href} compact={compact} />
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

/**
 * The help center's sections as tabs, above its collections (only with two or more). `href` links
 * a section's tab; plain links, so they work without JavaScript.
 */
export function SectionTabs({
  sections,
  active,
  href,
  compact = false,
}: {
  sections: { slug: string; name: string }[];
  active: string;
  href: (slug: string) => string;
  compact?: boolean;
}) {
  if (sections.length < 2) {
    return null;
  }
  return (
    <nav aria-label="Help center sections" className="flex gap-1 overflow-x-auto">
      {sections.map((section) => (
        <Link
          key={section.slug}
          href={href(section.slug)}
          aria-current={section.slug === active ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 whitespace-nowrap transition-colors",
            compact ? "text-xs" : "text-sm",
            section.slug === active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {section.name}
        </Link>
      ))}
    </nav>
  );
}
