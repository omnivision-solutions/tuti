import type { Doc } from "@tuti/content";
import { expect, test } from "vitest";

import { mergeSections, type TaggedEdit, takeOut } from "./article-layers";

/** An article of `## heading` sections, each with one paragraph. */
const doc = (...sections: [string, string][]): Doc => ({
  type: "doc",
  content: sections.flatMap(([heading, text]) => [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
    { type: "paragraph", content: [{ type: "text", text }] },
  ]),
});

const A: [string, string] = ["Light", "Pick Light."];
const B: [string, string] = ["Dark", "Dark is coming."];
const C: [string, string] = ["System", "Follows the device."];

test("an edit's sections are applied onto another's; the same section changed by both is refused", () => {
  const base = doc(A, B, C);
  expect(mergeSections(base, doc(["Light", "Pick Light or Dark."], B, C), doc(A, ["Dark", "Dark is here."], C))).toEqual(
    doc(["Light", "Pick Light or Dark."], ["Dark", "Dark is here."], C),
  );
  expect(mergeSections(base, doc(["Light", "Pick Light or Dark."], B, C), doc(["Light", "Pick Light only."], B, C))).toBeNull();
});

test("an edit that moves sections: kept as it is onto the text it was written on, refused onto another (never dropped)", () => {
  const base = doc(A, B, C);
  const moved = doc(B, A, C);
  expect(mergeSections(base, moved, base)).toEqual(moved);
  // Merged by section onto a text that changed meanwhile, the move would be lost: written again instead.
  expect(mergeSections(base, moved, doc(A, B, ["System", "Follows the device, always."]))).toBeNull();
});

test("taking out an edit that moved sections puts them back, or is refused once the text changed since", () => {
  const edit: TaggedEdit = { revisionId: "r2", actionId: "a", number: 12, createdAt: new Date(), base: doc(A, B, C), doc: doc(B, A, C) };
  expect(takeOut(edit, doc(B, A, C), [])).toEqual({ doc: doc(A, B, C) });
  expect(takeOut(edit, doc(B, A, ["System", "Follows the device, always."]), [])).toHaveProperty("refused");
});

test("an edit whose base is gone is never taken out as if it were all of the article", () => {
  const edit: TaggedEdit = { revisionId: "r2", actionId: "a", number: 12, createdAt: new Date(), base: null, doc: doc(A, B) };
  expect(takeOut(edit, doc(A, B), [])).toHaveProperty("refused");
});

test("taking out an edit names only the edits after it as on top, matched by its revision; one not listed names none", () => {
  const edit = (revisionId: string, number: number, base: Doc, after: Doc): TaggedEdit => ({ revisionId, actionId: revisionId, number, createdAt: new Date(0), base, doc: after });
  const lower = edit("r1", 1, doc(A), doc(["Light", "Pick Light or Dark."]));
  const upper = edit("r2", 2, doc(["Light", "Pick Light or Dark."]), doc(["Light", "Pick Light, Dark or System."]));
  const text = doc(["Light", "Pick Light, Dark or System."]);
  expect(takeOut({ ...lower }, text, [lower, upper])).toEqual({ refused: "PR #2's edit changed the same section since: take it out first" });
  // The upper one, its own copy: nothing is on top of it, and the lower one isn't named.
  expect(takeOut({ ...upper, base: doc(["Light", "Pick Light only."]) }, doc(["Light", "Pick Light."]), [lower, upper])).toEqual({
    refused: "Someone edited the same section since: change it in the editor instead",
  });
  // Not in the list: none named.
  expect(takeOut(edit("r9", 9, doc(A), doc(["Light", "Other."])), text, [lower, upper])).toEqual({ refused: "Someone edited the same section since: change it in the editor instead" });
});
