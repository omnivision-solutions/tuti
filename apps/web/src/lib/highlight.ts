/**
 * `text` split for highlighting what a search matched: plain parts at even indexes, matched ones at
 * odd. A match is a whole word starting with one of the query's words ("sign" marks "signed", not
 * just its start: half a word marked reads as two).
 */
export function highlightParts(text: string, query: string): string[] {
  // A word's accents may be marks of their own after its letters (é as e + ´): they're part of it.
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)?.slice(0, 8) ?? [];
  if (words.length === 0) {
    return [text];
  }
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  return text.split(new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])((?:${escaped.join("|")})[\\p{L}\\p{N}\\p{M}]*)`, "giu"));
}
