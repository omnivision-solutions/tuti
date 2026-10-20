export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Past this many line pairs a diff shows everything as replaced, rather than use a lot of memory. */
const MAX_CELLS = 4_000_000;

/**
 * The lines (paragraphs of an article's plain text; blank ones skipped) removed from `before`
 * and added in `after`, in order: the longest common subsequence, after trimming what both start
 * and end with. ponytail: O(n·m) for the changed middle; past MAX_CELLS it gives up and shows it all
 * as replaced (only articles rewritten end to end get there).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
    end++;
  }
  const same = (text: string): DiffLine => ({ kind: "same", text });
  const removed = (text: string): DiffLine => ({ kind: "removed", text });
  const added = (text: string): DiffLine => ({ kind: "added", text });
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);

  const middle: DiffLine[] = [];
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    middle.push(...x.map(removed), ...y.map(added));
  } else {
    // lcs[i][j]: how many lines x[i..] and y[j..] have in common, in order.
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push(same(x[i++]!));
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        middle.push(removed(x[i++]!));
      } else {
        middle.push(added(y[j++]!));
      }
    }
    middle.push(...x.slice(i).map(removed), ...y.slice(j).map(added));
  }
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(a.length - end).map(same)];
}
