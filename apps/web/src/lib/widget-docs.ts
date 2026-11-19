/** The longest question the docs' AI takes (docs.ask); a longer message in Messages goes to the team (AI first). */
export const MAX_QUESTION = 300;

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

/**
 * Where an AI answer's source opens in the widget: an article in the panel's Help center (its page is a link away from
 * there); null for an API reference's operation ("<reference>/<operation>"), which the panel can't show, so it opens on
 * its page in a new tab (AnswerSources).
 */
export function widgetSourceHref(slug: string): string | null {
  return slug.includes("/") ? null : docsHref({ article: slug });
}
