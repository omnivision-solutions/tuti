import { expect, test } from "vitest";

import { readNotes } from "./notes";

const text = (value: string) => [{ type: "text", text: value }];
const item = (value: string) => ({ type: "listItem", content: [{ type: "paragraph", content: text(value) }] });

test("the model's numbered steps are a numbered list, its \"- \" items a bulleted one, each kind a list of its own", () => {
  const read = readNotes(JSON.stringify({ notes: "## Export it\n\n1. Open Settings.\n2. Pick Export.\n- A row per event.\n\n3) Save it." }), new Set());
  expect(read?.doc.content).toEqual([
    { type: "heading", attrs: { level: 2 }, content: text("Export it") },
    { type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] },
    { type: "bulletList", content: [item("A row per event.")] },
    // Starting past 1, it keeps its number.
    { type: "orderedList", attrs: { start: 3 }, content: [item("Save it.")] },
  ]);
});

test("two numbered lists one after the other stay two: a step numbered 1 again starts a new list", () => {
  const read = readNotes(JSON.stringify({ notes: "1. Open Settings.\n2. Pick Export.\n\n1. Open Team.\n2. Invite them." }), new Set());
  expect(read?.doc.content).toEqual([
    { type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] },
    { type: "orderedList", content: [item("Open Team."), item("Invite them.")] },
  ]);
});

test("steps numbered \"1.\" every time are one list, as Markdown counts them", () => {
  const read = readNotes(JSON.stringify({ notes: "1. Open Settings.\n1. Pick Export.\n1. Save it." }), new Set());
  expect(read?.doc.content).toEqual([{ type: "orderedList", content: [item("Open Settings."), item("Pick Export."), item("Save it.")] }]);
});

test("a list counting 1, 2 then 2 again on the next line is two lists: only a list numbered the same throughout counts lazily", () => {
  const read = readNotes(JSON.stringify({ notes: "1. Open Settings.\n2. Pick Export.\n2. Open Team.\n3. Invite them." }), new Set());
  expect(read?.doc.content).toEqual([
    { type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] },
    { type: "orderedList", attrs: { start: 2 }, content: [item("Open Team."), item("Invite them.")] },
  ]);
});
