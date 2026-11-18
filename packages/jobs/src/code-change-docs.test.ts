import { type Doc, storedArticle, toPlainText } from "@tuti/content";
import { expect, test } from "vitest";

import { ADD_RULE, articleNotes, EDIT_SYSTEM, NEW_SYSTEM, PASSAGES_RULE, WAITING_RULE, WRITING_RULES } from "./code-change-docs";
import { CHECK_SYSTEM } from "./verify";

const toPlain = (doc: Doc | null) => (doc ? toPlainText(doc) : "");
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
    // "Free" is there twice (a cell and a paragraph), so it can't be named: it isn't offered. The code block is one, fenced.
    passages: ["Export", "Run it from Settings.", "```bash\nnpm run export\n```", "Plan", "Seats", "3", "It takes a minute."],
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

test("in a section that isn't editable, a passage is taken out or has text added after it, code is changed in place, and one passage operation does one thing", () => {
  const { notes, edit } = articleNotes({ type: "doc", content: [para("Run it from Settings."), code, para("It takes a minute.")] });
  expect(notes[0]!.passages).toEqual(["Run it from Settings.", "```bash\nnpm run export\n```", "It takes a minute."]);
  const next = edit({
    passages: [
      { section: 1, find: "```bash\nnpm run export\n```", replace: "```bash\nnpm run download\n```" },
      { section: 1, find: "It takes a minute.", replace: "" },
      { section: 1, after: "Run it from Settings.", insert: "Only admins see it." },
    ],
  })!;
  expect(next.content).toEqual([para("Run it from Settings."), para("Only admins see it."), { ...code, attrs: { language: "bash", filename: null }, content: text("npm run download") }]);
  // A find with an insert, or an after with a replace, is neither: refused, not guessed.
  expect(edit({ passages: [{ section: 1, find: "It takes a minute.", replace: "", insert: "More." }] })).toBeNull();
  expect(edit({ passages: [{ section: 1, after: "It takes a minute.", insert: "More.", replace: "Less." }] })).toBeNull();
  expect(edit({ passages: [{ section: 1, after: "It takes a minute.", insert: 3 }] })).toBeNull();
});

test("a section is taken out whole by taking out every passage in it, its heading too; its heading alone can't go", () => {
  const head = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: text(value) });
  const { edit } = articleNotes({ type: "doc", content: [para("Intro."), head("Contact button"), para("It sits in the header."), code, head("Links"), para("Add links.")] });
  const out = (find: string) => ({ section: 2, find, replace: "" });
  expect(edit({ passages: [out("Contact button"), out("It sits in the header."), out("```bash\nnpm run export\n```")] })?.content).toEqual([para("Intro."), head("Links"), para("Add links.")]);
  // Its heading alone, or with some of its text left: that text would join the section above.
  expect(edit({ passages: [out("Contact button")] })).toBeNull();
  expect(edit({ passages: [out("Contact button"), out("It sits in the header.")] })).toBeNull();
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
  // And the other way round: a section with code isn't rewritten whole, and the rest of that reply isn't used either.
  expect(edit({ sections: { "1": "## Setup\n\nInstall it first.", "3": "## Files\n\nThey're CSV or JSON." } })).toBeNull();
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
    // The format line doesn't contradict what a passage keeps.
    expect(prompt).toContain('In "passages", also *italics*, <br> and code, as the passage has them.');
  }
  // A correction is made where the old text stands (E1): code, italics and something gone are changed or taken out by
  // passages, so the note at the end is only for what nothing can change (a person's section, text that's no passage),
  // so the team still hears of it.
  expect(ADD_RULE).toContain('Never use "add" to correct anything you can change where it stands: change it there.');
  expect(ADD_RULE).toContain('a statement is wrong where nothing can be changed (in a section marked "edited_by_team", or text that\'s neither in an editable section nor among the passages)');
  expect(ADD_RULE).not.toMatch(/what's wrong is in code|a passage describes something that's gone/);
  // Its heading is a new one: one the article has already is refused (edit), so the rule can't ask for it.
  expect(ADD_RULE).toContain("it starts with a ## heading that isn't one the article already has");
  // A passage for something that's gone is taken out, never turned into something else.
  expect(PASSAGES_RULE).toContain("When what a passage describes is gone, take it out; don't reuse it for something else.");
  // Something missing goes after a passage of the section it belongs in; the end only takes what belongs in no section.
  expect(PASSAGES_RULE).toContain('To add after one, "after" is the passage exactly as listed and "insert" the new text');
  expect(ADD_RULE).toContain("it belongs in none of its sections")
  expect(NEW_SYSTEM).not.toContain('"add"');
  // Only the edit's writer gets waiting edits marked (E4); Verify reads the article as it is.
  expect(EDIT_SYSTEM).toContain(WAITING_RULE);
  expect(CHECK_SYSTEM).not.toContain(WAITING_RULE);
});

test("sections with waiting edits are marked with them; one held (a person changed its edit) is shown but can't be changed", () => {
  const para = (value: string) => ({ type: "paragraph", content: text(value) });
  const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: text(value) });
  const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para("Dark")] }] }] };
  const doc: Doc = { type: "doc", content: [para("Pick a theme."), heading("Dark"), para("Dark is here."), heading("Table"), para("See below."), table] };
  const { notes, edit } = articleNotes(doc, [
    { by: ["PR #1", "PR #2"], held: false },
    { by: ["PR #3"], held: true },
    { by: ["PR #3"], held: true },
  ]);
  expect(notes).toEqual([
    { number: 1, editable: true, text: "Pick a theme.", waiting: "PR #1, PR #2" },
    { number: 2, editable: false, text: "## Dark\n\nDark is here.", edited_by_team: "PR #3" },
    expect.objectContaining({ number: 3, editable: false, edited_by_team: "PR #3" }),
  ]);
  expect(notes[2]).not.toHaveProperty("passages");
  // The waiting section is written as any other; a held one refuses the edit, whole or by a passage.
  expect(toPlain(edit({ sections: { "1": "Pick Light or Dark." } }))).toContain("Pick Light or Dark.");
  expect(edit({ sections: { "1": "Pick Light or Dark.", "2": "## Dark\n\nDark is out." } })).toBeNull();
  expect(edit({ passages: [{ section: 3, find: "See below.", replace: "See the table." }] })).toBeNull();
  // Without marks (Verify), the same table's passages are listed and may be replaced.
  expect(articleNotes(doc).edit({ passages: [{ section: 3, find: "See below.", replace: "See the table." }] })).not.toBeNull();
});
