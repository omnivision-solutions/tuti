import { expect, test } from "vitest";

import { diffBlocks, diffLines } from "./line-diff";

const show = (before: string, after: string) =>
  diffLines(before, after).map(({ kind, text }) => `${{ same: " ", added: "+", removed: "-" }[kind]}${text}`);

test("lines added, removed and changed between two versions, in order; blank lines don't count", () => {
  expect(show("Intro\n\nOld step\nShared\nGone", "Intro\nNew step\nShared\n\nAdded at the end")).toEqual([
    " Intro",
    "-Old step",
    "+New step",
    " Shared",
    "-Gone",
    "+Added at the end",
  ]);
  expect(show("Same\nText", "Same\nText")).toEqual([" Same", " Text"]);
  expect(show("", "First line")).toEqual(["+First line"]);
  expect(show("Moved\nA\nB", "A\nB\nMoved")).toEqual(["-Moved", " A", " B", "+Moved"]);
});

test("a huge rewrite shows as replaced instead of using a lot of memory", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const diff = diffLines(`Title\n${before}\nEnd`, `Title\n${after}\nEnd`);
  expect(diff).toHaveLength(6002);
  expect(diff[0]).toEqual({ kind: "same", text: "Title" });
  expect(diff[1]).toEqual({ kind: "removed", text: "old 0" });
  expect(diff[3001]).toEqual({ kind: "added", text: "new 0" });
  expect(diff.at(-1)).toEqual({ kind: "same", text: "End" });
});

test("blocks compare with their formatting, and a list's items one by one", () => {
  const text = (value: string, bold = false) => ({ type: "text", text: value, ...(bold ? { marks: [{ type: "bold" }] } : {}) });
  const p = (value: string, bold = false) => ({ type: "paragraph", content: [text(value, bold)] });
  const item = (value: string) => ({ type: "listItem", content: [p(value)] });
  const before = { type: "doc", content: [p("Intro"), p("Save draft"), { type: "orderedList", attrs: { start: 1 }, content: [item("One"), item("Two")] }] };
  const after = { type: "doc", content: [p("Intro"), p("Save draft", true), { type: "orderedList", attrs: { start: 1 }, content: [item("One"), item("Two!")] }] };
  const diff = diffBlocks(before, after);
  expect(diff.map(({ kind }) => kind)).toEqual(["same", "removed", "added", "same", "removed", "added"]);
  // Bold now: the added paragraph keeps its mark.
  expect(diff[2]!.doc.content).toEqual([p("Save draft", true)]);
  // The second item keeps its number.
  expect(diff[5]!.doc.content).toEqual([{ type: "orderedList", attrs: { start: 2 }, content: [item("Two!")] }]);
});
