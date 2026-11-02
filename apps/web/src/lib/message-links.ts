/**
 * `text` split around the web addresses in it: plain parts at even indexes, addresses at odd. Only http(s) addresses
 * (javascript: and the like stay text); punctuation after one ends the sentence, not the address ("see https://a.io/x."),
 * as does a bracket it didn't open ("(https://a.io/x)", while "https://a.io/Foo_(bar)" keeps its own).
 */
export function linkParts(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"“”]+/gi)) {
    // Over 2048 characters stays text, as `isSafeLink` keeps links: nor is a huge run of brackets trimmed one by one.
    if (match[0].length > 2048) {
      continue;
    }
    const count = (char: string) => match[0].split(char).length - 1;
    const unopened: Record<string, number> = { ")": count(")") - count("("), "]": count("]") - count("[") };
    let end = match[0].length;
    for (; end > 0; end--) {
      const last = match[0][end - 1]!;
      if (last in unopened ? unopened[last]-- <= 0 : !/[.,;:!?'*_‘’…。、]/u.test(last)) {
        break;
      }
    }
    const url = match[0].slice(0, end);
    if (!/^https?:\/\/./i.test(url)) {
      continue;
    }
    parts.push(text.slice(from, match.index), url);
    from = match.index + url.length;
  }
  parts.push(text.slice(from));
  return parts;
}
