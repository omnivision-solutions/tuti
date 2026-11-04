const byTitle = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Articles in reading order: by `order`, and articles that share one (made before it existed, or
 * inserted in bulk) by title as numbers read ("Step 2" before "Step 10"), which the database's text
 * order doesn't do.
 */
export function inArticleOrder<T extends { order: number; title: string }>(articles: T[]): T[] {
  return articles.toSorted((a, b) => a.order - b.order || byTitle(a.title, b.title));
}
