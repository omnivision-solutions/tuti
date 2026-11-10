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

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const ignored = new Set(["a", "an", "the", "is", "are", "it", "has", "have", "to", "for", "of", "in", "with", "your", "you", "and", "can", "gets", "get", "includes", "include"]);
/** Match a paraphrase conservatively: shared content words, unchanged quantities, and a unique best sentence. */
export function matchingSentence(statement: string, candidates: string[]) {
  const wanted = words(statement), content = new Set(wanted.filter((word) => !ignored.has(word)));
  if (!content.size) return -1;
  const exact = candidates.map((candidate, index) => ({ index, matches: (` ${words(candidate).join(" ")} `).includes(` ${wanted.join(" ")} `) })).filter((candidate) => candidate.matches);
  if (exact.length) return exact.length === 1 ? exact[0]!.index : -1;
  const numbers = wanted.filter((word) => /\d/.test(word)).sort().join(" ");
  const scores = candidates.map((candidate, index) => {
    const tokens = words(candidate);
    if (tokens.filter((word) => /\d/.test(word)).sort().join(" ") !== numbers) return { index, score: 0 };
    const found = new Set(tokens.filter((word) => !ignored.has(word)));
    const shared = [...content].filter((word) => found.has(word)).length;
    return { index, score: shared >= Math.min(3, content.size) ? shared / Math.max(content.size, found.size) : 0 };
  }).sort((a, b) => b.score - a.score);
  return scores[0] && scores[0].score >= 0.55 && scores[0].score > (scores[1]?.score ?? 0) + 0.1 ? scores[0].index : -1;
}
