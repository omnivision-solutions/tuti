/** The reply and what was selected in it as the picker opened. */
export type Opened = { text: string; start: number; end: number };

/**
 * Where the link goes in `text`: what was selected as the picker opened while the reply is as it was then; at its end
 * once it changed meanwhile (an AI draft landed), as offsets into other text could land anywhere in it.
 */
export function insertAt(opened: Opened, text: string): [number, number] {
  return text === opened.text ? [opened.start, opened.end] : [text.length, text.length];
}

/**
 * What goes in place of `text`'s characters `start` to `end` (the selection, or the cursor where they're equal) for an
 * article's link: its title and address, as AI drafts cite them, a space either side where it would run into the words
 * around it (not before punctuation). With where the cursor goes after (the link's end, in the text with it in).
 */
export function linkToInsert(text: string, start: number, end: number, article: { title: string; url: string }): { insert: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const link = `${before && !/\s$/.test(before) ? " " : ""}${article.title}: ${article.url}`;
  return { insert: `${link}${/^[^\s.,;:!?)]/.test(after) ? " " : ""}`, caret: before.length + link.length };
}
