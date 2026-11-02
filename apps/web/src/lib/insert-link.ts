/**
 * `text` with an article's link put in place of its characters `start` to `end` (the selection, or the cursor where
 * they're equal): its title and address, as AI drafts cite them, a space either side where it would run into the words
 * around it. With where the cursor goes after: the link's end.
 */
export function insertLink(text: string, start: number, end: number, article: { title: string; url: string }): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const link = `${before && !/\s$/.test(before) ? " " : ""}${article.title}: ${article.url}`;
  return { text: `${before}${link}${after && !/^\s/.test(after) ? " " : ""}${after}`, caret: before.length + link.length };
}
