import { storedArticle } from "@tuti/content";
import { expect, test } from "vitest";

import { ADD_RULE, articleNotes, EDIT_SYSTEM, NEW_SYSTEM, PASSAGES_RULE, WRITING_RULES } from "./code-change-docs";
import { CHECK_SYSTEM } from "./verify";

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

const cell = (value: string) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [para(value)] });
const table = { type: "table", content: [{ type: "tableRow", content: [cell("Plan"), cell("Seats")] }, { type: "tableRow", content: [cell("Free"), cell("3")] }] };
const code = { type: "codeBlock", attrs: { language: "bash" }, content: text("npm run export") };

test("a section with a table or code isn't rewritten whole: it lists its passages, and one is replaced where it stands, everything beside it untouched", () => {
  // As the article is stored (every attribute spelled out), so what comes back can be compared with it node by node.
  const { content } = storedArticle({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2 }, content: text("Export") }, para("Run it from Settings."), image("a".repeat(24), "The terminal"), code, table, para("Free"), para("It takes a minute.")],
  }) as { content: { type: string; attrs?: object; content: { content: { content: object[] }[] }[] }[] };
  const { notes, edit } = articleNotes({ type: "doc", content });
  expect(notes[0]).toMatchObject({
    editable: false,
    // "Free" is there twice (a cell and a paragraph), so it can't be named: it isn't offered.
    passages: ["Export", "Run it from Settings.", "Plan", "Seats", "3", "It takes a minute."],
  });
  // Its whole text can't be sent back.
  expect(edit({ sections: { "1": "## Export\n\nRun it from Team." } })).toBeNull();
  const next = edit({ passages: [{ section: 1, find: "Run it from Settings.", replace: "Run it from **Workspace settings**." }, { section: 1, find: "3", replace: "5" }] })!;
  const [head, intro, shot, block, grid, ...rest] = content;
  const [free, seats] = grid!.content[1]!.content;
  expect(next.content).toEqual([
    head,
    { ...intro, content: [...text("Run it from "), { type: "text", text: "Workspace settings", marks: [{ type: "bold" }] }, ...text(".")] },
    shot,
    block,
    { ...grid, content: [grid!.content[0], { ...grid!.content[1], content: [free, { ...seats, content: [para("5")] }] }] },
    ...rest,
  ]);
});

test("a passage that can't be replaced refuses the whole edit, as a section that can't be used does", () => {
  const { edit } = articleNotes({ type: "doc", content: [para("Run it from Settings."), code, para("Free"), para("Free"), { type: "heading", attrs: { level: 2 }, content: text("More") }, para("See below.")] });
  const good = { section: 1, find: "Run it from Settings.", replace: "Run it from Team." };
  expect(edit({ passages: [good] })).not.toBeNull();
  for (const refused of [
    { section: 1, find: "Run it from settings.", replace: "Run it from Team." },
    { section: 1, find: "Free", replace: "Starter" },
    { section: 1, find: "npm run export", replace: "npm run exports" },
    { section: 1, find: "Run it from Settings.", replace: "Run `npm run exports`." },
    // Another section's passage, a section that isn't there, and a reply that isn't a passage.
    { section: 1, find: "See below.", replace: "See above." },
    { section: 9, find: "Run it from Settings.", replace: "Run it from Team." },
    { section: 1, find: "Run it from Settings." },
    "Run it from Team.",
  ]) {
    expect(edit({ passages: [good, refused] })).toBeNull();
    expect(edit({ sections: { "2": "## More\n\nSee above." }, passages: [refused] })).toBeNull();
  }
  // The same passage named twice: the second isn't found any more.
  expect(edit({ passages: [good, good] })).toBeNull();
});

const mixed = () => articleNotes({ type: "doc", content: [para("Run it from Settings."), code, { type: "heading", attrs: { level: 2 }, content: text("More") }, para("See below.")] });

test("passages that aren't a list refuse the whole edit: the rest of it isn't applied without them", () => {
  const { edit } = mixed();
  const good = { section: 1, find: "Run it from Settings.", replace: "Run it from Team." };
  const sections = { "2": "## More\n\nSee above." };
  // The model sent one passage, not a list of them: the rest of the edit isn't applied without it.
  expect(edit({ sections, passages: good })).toBeNull();
  expect(edit({ sections, passages: "Run it from Team." })).toBeNull();
  // Left out, or empty: an edit like any other.
  expect(edit({ sections })).not.toBeNull();
  expect(edit({ sections, passages: [] })).not.toBeNull();
});

test("a passage whose section isn't a section's number refuses the edit, without throwing", () => {
  const { edit } = mixed();
  const good = { section: 1, find: "Run it from Settings.", replace: "Run it from Team." };
  const sections = { "2": "## More\n\nSee above." };
  // A number, or its digits as "sections" has them.
  expect(edit({ passages: [good] })).not.toBeNull();
  expect(edit({ passages: [{ ...good, section: "1" }] })).not.toBeNull();
  for (const section of [{ toString: null }, true, [1], 1.5, 0, -1, "1.0", " 1", "", null, undefined]) {
    expect(edit({ sections, passages: [{ ...good, section }] })).toBeNull();
  }
});

test("a heading can't be renamed to a title another heading in the article has: the edit would take that section's place", () => {
  const head = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: text(value) });
  const { edit } = articleNotes({ type: "doc", content: [head("Setup"), para("Install it."), head("Export"), para("Run it."), head("Files"), para("They're CSV."), code] });
  // Rewritten whole, and by its heading's passage.
  expect(edit({ sections: { "2": "## Setup\n\nRun it." } })).toBeNull();
  expect(edit({ passages: [{ section: 3, find: "Files", replace: "Setup" }] })).toBeNull();
  expect(edit({ sections: { "2": "## Export\n\nRun it.\n\n## Setup\n\nAgain." } })).toBeNull();
  // Two headings swapping titles: unique afterwards, and still each in the other's place.
  expect(edit({ sections: { "1": "## Export\n\nInstall it.", "2": "## Setup\n\nRun it." } })).toBeNull();
  expect(edit({ passages: [{ section: 3, find: "Files", replace: "Setup" }], sections: { "1": "## Files\n\nInstall it." } })).toBeNull();
  // A section keeps its heading at its top: dropped, or with text before it, its text would join the section above.
  expect(edit({ sections: { "2": "Run it from Team." } })).toBeNull();
  expect(edit({ sections: { "2": "Intro.\n\n## Export\n\nRun it." } })).toBeNull();
  // A passage is only taken in a section that lists them: an editable one is rewritten whole.
  expect(edit({ passages: [{ section: 1, find: "Install it.", replace: "Install it first." }] })).toBeNull();
  expect(edit({ sections: { "1": "## Setup\n\nInstall it first." } })).not.toBeNull();
  // A title no other heading has is a rename like any other.
  expect(edit({ sections: { "2": "## Export to CSV\n\nRun it." } })).not.toBeNull();
  expect(edit({ passages: [{ section: 3, find: "Files", replace: "File formats" }] })).not.toBeNull();
  // Headings the edit left alone may repeat: an article that has two alike is still edited.
  const twice = articleNotes({ type: "doc", content: [head("Notes"), para("One."), head("Notes"), para("Two."), code] });
  expect(twice.edit({ sections: { "1": "## Notes\n\nFirst." } })).not.toBeNull();
  expect(twice.edit({ passages: [{ section: 2, find: "Two.", replace: "Second." }] })).not.toBeNull();
  // Nor one more with their title added, in a section or at the end.
  expect(twice.edit({ sections: { "1": "## Notes\n\nOne.\n\n## Notes\n\nMore." } })).toBeNull();
  expect(twice.edit({ add: "## Notes\n\nThree." })).toBeNull();
  expect(twice.edit({ add: "## Limits\n\nThree." })).not.toBeNull();
  // But one of the two can't be renamed: the other would be counted in its place.
  expect(twice.edit({ sections: { "1": "## Notes for admins\n\nOne." } })).toBeNull();
  expect(twice.edit({ passages: [{ section: 2, find: "Notes", replace: "Notes for admins" }] })).toBeNull();
});

test("the three writers (an edit, a new article, Verify's fix) share one set of writing rules, and the two with a section for the end share when it may be used and how passages are replaced", () => {
  for (const prompt of [EDIT_SYSTEM, NEW_SYSTEM, CHECK_SYSTEM]) {
    expect(prompt).toContain(WRITING_RULES);
    expect(prompt).not.toMatch(/as little as you can/);
  }
  for (const prompt of [EDIT_SYSTEM, CHECK_SYSTEM]) {
    expect(prompt).toContain(ADD_RULE);
    expect(prompt).toContain(PASSAGES_RULE);
    expect(prompt).toContain('"passages": [{"section": <number>, "find"');
  }
  // A correction is made where the old text stands: the section for the end isn't its way out any more.
  expect(ADD_RULE).toContain('Never use "add" to correct a sentence you can change where it stands.');
  expect(ADD_RULE).not.toContain("the statement that's wrong is in a section that isn't editable;");
  // Its heading is a new one: one the article has already is refused (edit), so the rule can't ask for it.
  expect(ADD_RULE).toContain("under a new heading that says what the note corrects, never a heading the article already has");
  expect(ADD_RULE).not.toContain("under a heading that names that section");
  // A passage for something that's gone can't be taken out or turned into something else: both rules send it to the end section.
  expect(PASSAGES_RULE).toContain("don't reuse the passage for something else");
  expect(ADD_RULE).toContain("or a passage describes something that's gone");
  // Something missing whose place is a section that only takes passages still has a way in.
  expect(ADD_RULE).toContain("there's no editable section to add it to");
  expect(NEW_SYSTEM).not.toContain('"add"');
});
