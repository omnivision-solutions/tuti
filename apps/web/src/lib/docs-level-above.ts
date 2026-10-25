/** A tab's page: the first is /docs itself. */
export const docsTabPath = (docs: { home: string | null }, tab: string) => (tab === docs.home ? "/docs" : `/docs/${tab}`);

/**
 * The level above a top-level collection or an article in none, for a reader who sees `docs.tabs`: its
 * tab's page with two tabs or more, else the docs' home, "All collections" (/docs shows a reader's
 * only tab even when it isn't the first, which they may not read).
 */
export const allCollections = (
  docs: { home: string | null; tabs: { slug: string }[] },
  tab: { slug: string; name: string } | null | undefined,
): { href: string; label: string } =>
  tab && docs.tabs.length > 1 ? { href: docsTabPath(docs, tab.slug), label: tab.name } : { href: "/docs", label: "All collections" };
