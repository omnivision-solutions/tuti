import { expect, test } from "vitest";

import type { Doc } from "./document";
import { editedSections, keyed, mergeSections, withSectionsOf } from "./sections";

const doc = (...sections: [string, string][]): Doc => ({
  type: "doc",
  content: sections.flatMap(([heading, text]) => [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
    { type: "paragraph", content: [{ type: "text", text }] },
  ]),
});
const headings = (d: Doc) => keyed(d).map(([key]) => key.split("\u0000")[0]);

test("a section only `from` has goes after the one before it there, not at the end", () => {
  const now = doc(["Light", "a"], ["Dark", "b"]);
  const mine = doc(["Light", "a"], ["Contrast", "c"], ["Dark", "b"]);
  expect(headings(withSectionsOf(now, mine, new Set(keyed(mine).filter(([key]) => key.startsWith("Contrast")).map(([key]) => key))))).toEqual(["Light", "Contrast", "Dark"]);
});

test("both taking out the same section takes out only that one, the others' edits kept", () => {
  const base = doc(["Light", "a"], ["Contrast", "c"], ["Dark", "b"]);
  const ours = doc(["Light", "a"], ["Dark", "b"]);
  const theirs = doc(["Light", "a"], ["Dark", "b!"]);
  expect(mergeSections(base, ours, theirs)).toEqual(theirs);
});

test("a section with a link the editor's user left alone isn't edited, though the editor's JSON gives the link more attributes", () => {
  const linked = (attrs: Record<string, unknown>): Doc => ({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Light" }] },
      { type: "paragraph", content: [{ type: "text", text: "See the guide", marks: [{ type: "link", attrs }] }] },
    ],
  });
  const stored = linked({ href: "https://example.com/guide" });
  const fromEditor = linked({ href: "https://example.com/guide", target: "_blank", rel: "noopener noreferrer nofollow", class: null });
  expect(editedSections(stored, fromEditor)).toEqual([]);
  expect(editedSections(stored, linked({ href: "https://example.com/other", target: "_blank" }))).toEqual(["Light\u00000"]);
});
