/** A widget Docs URL: the list (with the search, if any, or in a docs tab, or a collection's) or an article (opened from there). */
export function docsHref({ q, docsTab, collection, article }: { q?: string; docsTab?: string; collection?: string; article?: string }) {
  const params = new URLSearchParams({ tab: "docs" });
  for (const [key, value] of Object.entries({ q, docsTab, collection, article })) {
    if (value) {
      params.set(key, value);
    }
  }
  return `/widget?${params}`;
}
