import type { JSONContent } from "@tiptap/core";
import { listStart } from "@tuti/content";

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Past this many line pairs a diff shows everything as replaced, rather than use a lot of memory. */
const MAX_CELLS = 4_000_000;

/**
 * The lines (paragraphs of an article's plain text; blank ones skipped) removed from `before`
 * and added in `after`, in order (see diffBy).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
  return diffBy(lines(before), lines(after), (line) => line).map(({ kind, item }) => ({ kind, text: item }));
}

/**
 * The items removed from `a` and added in `b` (the same when their keys match; kept ones come from `b`),
 * in order: the longest common subsequence, after trimming what both start and end with.
 * ponytail: O(n·m) for the changed middle; past MAX_CELLS it gives up and shows it all as replaced
 * (only articles rewritten end to end get there).
 */
export function diffBy<T>(a: T[], b: T[], key: (item: T) => string): { kind: DiffLine["kind"]; item: T }[] {
  const ka = a.map(key);
  const kb = b.map(key);
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) {
    start++;
  }
  let end = 0;
  while (end < a.length - start && end < b.length - start && ka[a.length - 1 - end] === kb[b.length - 1 - end]) {
    end++;
  }
  const same = (item: T) => ({ kind: "same" as const, item });
  const removed = (item: T) => ({ kind: "removed" as const, item });
  const added = (item: T) => ({ kind: "added" as const, item });
  const x = ka.slice(start, a.length - end);
  const y = kb.slice(start, b.length - end);

  const middle: { kind: DiffLine["kind"]; item: T }[] = [];
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    middle.push(...a.slice(start, a.length - end).map(removed), ...b.slice(start, b.length - end).map(added));
  } else {
    // lcs[i][j]: how many items x[i..] and y[j..] have in common, in order.
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
        middle.push(same(b[start + j++]!));
        i++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        middle.push(removed(a[start + i++]!));
      } else {
        middle.push(added(b[start + j++]!));
      }
    }
    middle.push(...a.slice(start + i, a.length - end).map(removed), ...b.slice(start + j, b.length - end).map(added));
  }
  return [...b.slice(0, start).map(same), ...middle, ...b.slice(b.length - end).map(same)];
}

/**
 * The blocks removed from `before` and added in `after`, formatting included, each a document of
 * its own to render. A list's items count one by one (an ordered one's keep their numbers), so
 * changing one item doesn't mark the whole list; a new start number for the list marks them all.
 */
export function diffBlocks(before: JSONContent, after: JSONContent): { kind: DiffLine["kind"]; doc: JSONContent }[] {
  const blocks = (doc: JSONContent) =>
    (doc.content ?? []).flatMap((block) =>
      block.type === "bulletList" || block.type === "orderedList"
        ? (block.content ?? []).map((item, index) => {
            const start = block.type === "orderedList" ? listStart(block) : null;
            return {
              key: JSON.stringify([block.type, start, item]),
              block: { ...block, attrs: start === null ? block.attrs : { start: start + index }, content: [item] },
            };
          })
        : [{ key: JSON.stringify(block), block }],
    );
  return diffBy(blocks(before), blocks(after), (unit) => unit.key).map(({ kind, item }) => ({
    kind,
    doc: { type: "doc", content: [item.block] },
  }));
}
