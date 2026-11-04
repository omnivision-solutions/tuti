import { expect, test } from "vitest";

import { articleNotes } from "./code-change-docs";

const text = (value: string) => [{ type: "text", text: value }];
const item = (value: string) => ({ type: "listItem", content: [{ type: "paragraph", content: text(value) }] });

test("a section with numbered steps (as Autopilot drafts them) can be edited, and stays numbered", () => {
  const { notes, edit } = articleNotes({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: text("Export it") },
      { type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] },
    ],
  });
  expect(notes).toEqual([{ number: 1, editable: true, text: "## Export it\n\n1. Open Settings.\n2. Pick Export." }]);
  expect(edit({ sections: { "1": "## Export it\n\n1. Open Settings.\n2. Pick Export, then CSV." } })?.content).toMatchObject([
    { type: "heading", attrs: { level: 2 }, content: text("Export it") },
    { type: "orderedList", content: [item("Open Settings."), item("Pick Export, then CSV.")] },
  ]);
});

test("a list whose item holds more than one paragraph (a nested list, a second paragraph) isn't edited: it wouldn't come back as it was", () => {
  const nested = { type: "listItem", content: [{ type: "paragraph", content: text("Open Settings.") }, { type: "bulletList", content: [item("Pick CSV or JSON.")] }] };
  const twoParagraphs = { type: "listItem", content: [{ type: "paragraph", content: text("Open Settings.") }, { type: "paragraph", content: text("It's in the menu.") }] };
  for (const list of ["orderedList", "bulletList"]) {
    for (const first of [nested, twoParagraphs]) {
      const { notes } = articleNotes({ type: "doc", content: [{ type: list, content: [first, item("Click Export.")] }] });
      expect(notes[0]!.editable).toBe(false);
    }
  }
});
