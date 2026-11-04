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
