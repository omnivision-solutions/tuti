/** Count contiguous replacements once, rather than counting both sides of an edited paragraph. */
export function changedParagraphs(blocks: { kind: "same" | "added" | "removed" }[]) {
  let count = 0, added = 0, removed = 0;
  for (const block of [...blocks, { kind: "same" }]) {
    if (block.kind === "same") { count += Math.max(added, removed); added = removed = 0; }
    else if (block.kind === "added") added++;
    else removed++;
  }
  return count;
}

/** A short, quoted explanation of the words a waiting fix changes. */
export function fixSummary(before: string, after: string) {
  if (before === after) return null;
  const a = before.trim().split(/\s+/).filter(Boolean), b = after.trim().split(/\s+/).filter(Boolean);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const quote = (words: string[]) => `“${words.join(" ").slice(0, 100).replace(/[.,;:!?]+$/, "")}”`;
  return `${quote(a.slice(start, a.length - Math.max(0, end - 1)))} becomes ${quote(b.slice(start, b.length - Math.max(0, end - 1)))}`;
}

/** Keep original UTF-16 offsets so matched words can be underlined across inline formatting. */
export function sentenceTokens(value: string) {
  return [...value.matchAll(/[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}\p{Cf}]*/gu)].map((match) => ({
    word: match[0].replace(/\p{Cf}/gu, "").toLowerCase(),
    from: match.index,
    to: match.index + match[0].length,
  }));
}

/** Preserve word boundaries while ignoring punctuation, whitespace differences and invisible format characters. */
export const normalizeSentence = (value: string) => sentenceTokens(value).map(({ word }) => word).join(" ");

const spacelessScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Exact quote offsets, with substring matching for scripts whose clauses need no spaces. */
export function sentenceQuoteRange(value: string, quote: string, allowInsideClause = true) {
  const tokens = sentenceTokens(value);
  const text = tokens.map(({ word }) => word).join(" ");
  const wanted = normalizeSentence(quote);
  if (!wanted) return null;
  const start = (` ${text} `).indexOf(` ${wanted} `);
  if (start >= 0) {
    const first = text.slice(0, start).split(" ").filter(Boolean).length;
    return { from: tokens[first]!.from, to: tokens[first + wanted.split(" ").length - 1]!.to };
  }
  if (!spacelessScript.test(quote)) return null;
  // Keep an offset per normalized UTF-16 unit, including lowercase expansions.
  const letters = [...value.matchAll(/[\p{L}\p{N}\p{M}]/gu)].flatMap((match) =>
    match[0].toLowerCase().split("").map((word) => ({ word, from: match.index, to: match.index + match[0].length, spaceless: spacelessScript.test(match[0]) })),
  );
  const compact = letters.map(({ word }) => word).join("");
  const needle = wanted.replaceAll(" ", "");
  const boundary = (index: number) => {
    const left = letters[index - 1], right = letters[index];
    return !left || !right || (allowInsideClause && (left.spaceless || right.spaceless)) || value.slice(left.to, right.from).replace(/\p{Cf}/gu, "").length > 0;
  };
  for (let at = compact.indexOf(needle); at >= 0; at = compact.indexOf(needle, at + 1)) {
    // A mixed-script quote must still respect Latin words and numeric boundaries.
    if (boundary(at) && boundary(at + needle.length)) return { from: letters[at]!.from, to: letters[at + needle.length - 1]!.to };
  }
  return null;
}

/** Prefer quote boundaries anywhere in the article before trying inside a spaceless clause. */
export function findSentenceQuote(quote: string, candidates: string[]) {
  for (const allowInsideClause of [false, true]) {
    for (const [index, candidate] of candidates.entries()) {
      const range = sentenceQuoteRange(candidate, quote, allowInsideClause);
      if (range) return { ...range, index };
    }
  }
  return null;
}

const numberWords: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => numberWords[word] ?? word);
const ignored = new Set(["a", "an", "the", "is", "are", "it", "has", "have", "to", "for", "of", "in", "with", "your", "you", "and", "can", "gets", "get", "includes", "include", "each", "every", "either", "or"]);
const stem = (word: string) => word.length > 4 ? word.replace(/ies$/, "y").replace(/(ing|ed|s)$/, "").replace(/e$/, "") : word;
/** Prefer exact quotes. Older paraphrases match content words and inflections only when the block’s quantities agree. */
export function matchingSentence(statement: string, candidates: string[]) {
  const wanted = words(statement), content = new Set(wanted.filter((word) => !ignored.has(word)).map(stem));
  if (!content.size) return -1;
  const quantities = (tokens: string[]) => [...new Set(tokens.filter((word) => /\d/.test(word)))].sort().join(" ");
  const numbers = quantities(wanted);
  const exact = candidates.findIndex((candidate) => {
    const tokens = words(candidate);
    return (` ${tokens.join(" ")} `).includes(` ${wanted.join(" ")} `);
  });
  if (exact >= 0) return exact;
  const scores = candidates.map((candidate, index) => {
    const tokens = words(candidate);
    if (quantities(tokens) !== numbers) return { index, score: 0 };
    const found = new Set(tokens.filter((word) => !ignored.has(word)).map(stem));
    const shared = [...content].filter((word) => found.has(word)).length;
    return { index, score: shared >= Math.min(3, content.size) ? shared / content.size : 0 };
  }).sort((a, b) => b.score - a.score);
  return scores[0] && scores[0].score >= 0.65 && scores[0].score > (scores[1]?.score ?? 0) + 0.1 ? scores[0].index : -1;
}
