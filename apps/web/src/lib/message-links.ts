/**
 * `text` split around the web addresses in it: plain parts at even indexes, addresses at odd. Only http(s) addresses
 * (javascript: and the like stay text); punctuation after one ends the sentence, not the address ("see https://a.io/x."),
 * as does a bracket it didn't open ("(https://a.io/x)", while "https://a.io/Foo_(bar)" keeps its own).
 */
export function linkParts(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"]+/gi)) {
    let url = match[0];
    for (;;) {
      const last = url.at(-1)!;
      const opener = ({ ")": "(", "]": "[" } as Record<string, string>)[last];
      const extra = opener ? url.split(last).length > url.split(opener).length : /[.,;:!?'*_]/.test(last);
      if (!extra) {
        break;
      }
      url = url.slice(0, -1);
    }
    if (!/^https?:\/\/./i.test(url)) {
      continue;
    }
    parts.push(text.slice(from, match.index), url);
    from = match.index + url.length;
  }
  parts.push(text.slice(from));
  return parts;
}
