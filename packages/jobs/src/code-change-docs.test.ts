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

test("a list whose item holds more than one line (a nested list, a second paragraph, a line break) isn't edited: it wouldn't come back as it was", () => {
  const nested = { type: "listItem", content: [{ type: "paragraph", content: text("Open Settings.") }, { type: "bulletList", content: [item("Pick CSV or JSON.")] }] };
  const twoParagraphs = { type: "listItem", content: [{ type: "paragraph", content: text("Open Settings.") }, { type: "paragraph", content: text("It's in the menu.") }] };
  const twoLines = { type: "listItem", content: [{ type: "paragraph", content: [...text("Open Settings."), { type: "hardBreak" }, ...text("It's in the menu.")] }] };
  for (const list of ["orderedList", "bulletList"]) {
    for (const first of [nested, twoParagraphs, twoLines]) {
      const { notes } = articleNotes({ type: "doc", content: [{ type: list, content: [first, item("Click Export.")] }] });
      expect(notes[0]!.editable).toBe(false);
    }
  }
});

test("a section with two numbered lists one after the other keeps them two when it's edited", () => {
  const { edit } = articleNotes({
    type: "doc",
    content: [
      { type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] },
      { type: "orderedList", content: [item("Open Team."), item("Invite them.")] },
    ],
  });
  expect(edit({ sections: { "1": "1. Open Settings.\n2. Pick Export now.\n\n1. Open Team.\n2. Invite them." } })?.content).toMatchObject([
    { type: "orderedList", content: [item("Open Settings."), item("Pick Export now.")] },
    { type: "orderedList", content: [item("Open Team."), item("Invite them.")] },
  ]);
});

const image = (mediaId: string, alt: string) => ({ type: "image", attrs: { mediaId, width: "50", align: "left", alt, w: 640, h: 480 } });
const para = (value: string) => ({ type: "paragraph", content: text(value) });

test("a section with screenshots can be edited: each goes as its {{media N}} line and comes back as it was, the text around it changed", () => {
  const [menu, dialog] = [image("a".repeat(24), "The Settings menu"), image("b".repeat(24), "The Export dialog")];
  const { notes, edit } = articleNotes({
    type: "doc",
    content: [para("Open Settings."), menu, para("Pick Export."), dialog],
  });
  expect(notes).toEqual([{ number: 1, editable: true, text: "Open Settings.\n\n{{media 1}}\n\nPick Export.\n\n{{media 2}}" }]);
  expect(edit({ sections: { "1": "Open **Workspace settings**.\n\n{{media 1}}\n\nPick Export, then CSV.\n\n{{media 2}}" } })?.content).toEqual([
    { type: "paragraph", content: [...text("Open "), { type: "text", text: "Workspace settings", marks: [{ type: "bold" }] }, ...text(".")] },
    menu,
    para("Pick Export, then CSV."),
    dialog,
  ]);
});

test("an edit that drops, repeats, moves or makes up a {{media N}} isn't used", () => {
  const { notes, edit } = articleNotes({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: text("Export") },
      para("Open Settings."),
      image("a".repeat(24), "The Settings menu"),
      para("Pick Export."),
      image("b".repeat(24), "The Export dialog"),
      { type: "heading", attrs: { level: 2 }, content: text("Import") },
      para("Pick Import."),
      image("c".repeat(24), "The Import dialog"),
    ],
  });
  expect(notes.map((note) => note.editable)).toEqual([true, true]);
  const first = (value: string) => edit({ sections: { "1": `## Export\n\n${value}` } });
  expect(first("Open Settings now.\n\n{{media 1}}\n\nPick Export.\n\n{{media 2}}")).not.toBeNull();
  for (const refused of [
    "Open Settings now.\n\n{{media 1}}\n\nPick Export.",
    "Open Settings now.\n\n{{media 1}}\n\nPick Export.\n\n{{media 2}}\n\n{{media 1}}",
    "Open Settings now.\n\n{{media 2}}\n\nPick Export.\n\n{{media 1}}",
    // Another section's image, one that isn't there, and one not on its own line (it would be saved as text).
    "Open Settings now.\n\n{{media 1}}\n\nPick Export.\n\n{{media 2}}\n\n{{media 3}}",
    "Open Settings now.\n\n{{media 1}}\n\nPick Export.\n\n{{media 2}}\n\n{{media 9}}",
    "Open Settings now. {{media 1}}\n\nPick Export.\n\n{{media 2}}",
  ]) {
    expect(first(refused)).toBeNull();
  }
  // A new last section has no image of its own.
  expect(edit({ add: "## More\n\nSee below.\n\n{{media 1}}" })).toBeNull();
});

test("a section with a table or code beside its image still isn't edited", () => {
  const { notes } = articleNotes({
    type: "doc",
    content: [para("Run it."), image("a".repeat(24), "The terminal"), { type: "codeBlock", content: text("npm run export") }],
  });
  expect(notes[0]!.editable).toBe(false);
});
