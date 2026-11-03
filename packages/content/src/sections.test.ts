import { expect, test } from "vitest";

import type { Doc } from "./document";
import { editedSections, keyed, withSectionsOf } from "./sections";

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

test("the editor's edited sections: each one it changed, with how it had it (none for one it added)", () => {
  const had = doc(["Light", "a"], ["Dark", "b"]);
  const now = doc(["Light", "a!"], ["Contrast", "c"], ["Dark", "b"]);
  const edited = editedSections(had, now);
  expect(edited.map((section) => section.key.split("\u0000")[0]).sort()).toEqual(["Contrast", "Light"]);
  expect(edited.find((section) => section.key.startsWith("Contrast"))!.before).toBeNull();
  expect(edited.find((section) => section.key.startsWith("Light"))!.before).toEqual(keyed(had)[0]![1]);
});
