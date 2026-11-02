/**
 * What goes in place of `text`'s characters `start` to `end` (the selection, or the cursor where they're equal) for an
 * article's link: its title and address, as AI drafts cite them, a space either side where it would run into the words
 * around it. With where the cursor goes after (the link's end, in the text with it in). A range kept from before the
 * text changed (an AI draft landing, say) is taken as far as the text goes.
 */
export function linkToInsert(text: string, start: number, end: number, article: { title: string; url: string }): { insert: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const link = `${before && !/\s$/.test(before) ? " " : ""}${article.title}: ${article.url}`;
  return { insert: `${link}${after && !/^\s/.test(after) ? " " : ""}`, caret: before.length + link.length };
}
