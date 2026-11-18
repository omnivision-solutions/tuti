import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";

import { passagesIn, readNotes, replacePassage } from "./notes";

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

test("an empty step is dropped, and the list goes on past it", () => {
  const read = readNotes(JSON.stringify({ notes: "1. Open Settings.\n2.\n3. Pick Export." }), new Set());
  expect(read?.doc.content).toEqual([{ type: "orderedList", content: [item("Open Settings."), item("Pick Export.")] }]);
});

describe("passages: a block's text replaced where it stands", () => {
  type Mark = NonNullable<JSONContent["marks"]>[number];
  const text = (value: string, ...marks: Mark[]): JSONContent => ({ type: "text", text: value, ...(marks.length > 0 && { marks }) });
  const para = (...content: JSONContent[]) => ({ type: "paragraph", content });
  const cell = (type: string, value: string) => ({ type, attrs: { colspan: 1, rowspan: 1 }, content: [para(text(value))] });
  const table = {
    type: "table",
    content: [
      { type: "tableRow", content: [cell("tableHeader", "Plan"), cell("tableHeader", "Seats")] },
      { type: "tableRow", content: [cell("tableCell", "Free"), cell("tableCell", "3")] },
    ],
  };
  const code = { type: "codeBlock", attrs: { language: "bash", filename: null }, content: [text("npm run export")] };
  const image = { type: "image", attrs: { mediaId: "a".repeat(24), width: "50", align: "left", alt: "The Plans page", w: 640, h: 480 } };
  const heading = { type: "heading", attrs: { level: 3 }, content: [text("Plans")] };
  const intro = { type: "paragraph", attrs: { textAlign: "center" }, content: [text("Each plan has seats.")] };
  const step = { type: "listItem", content: [para(text("Open "), text("Billing", { type: "bold" }), text("."))] };
  const list = { type: "orderedList", attrs: { start: 2 }, content: [step, { type: "listItem", content: [para(text("Pick a plan.")), { type: "bulletList", content: [] }] }] };
  const section = [heading, intro, table, code, image, list];

  test("found once: only that block's text changes; its attributes and every other node stay the very objects they were", () => {
    const next = replacePassage(section, "Each plan has seats.", "Each plan has **seats** and a price.")!;
    expect(next[1]).toEqual({ type: "paragraph", attrs: { textAlign: "center" }, content: [text("Each plan has "), text("seats", { type: "bold" }), text(" and a price.")] });
    expect(next.map((node, i) => node === section[i])).toEqual([true, false, true, true, true, true]);
    // The stored article isn't written into.
    expect(intro.content).toEqual([text("Each plan has seats.")]);
  });

  test("a heading keeps its level; a list's item is replaced inside its list, the items beside it untouched", () => {
    expect(replacePassage(section, "Plans", "Plans and seats")![0]).toEqual({ type: "heading", attrs: { level: 3 }, content: [text("Plans and seats")] });
    const next = replacePassage(section, "Open **Billing**.", "Open **Plans**.")!;
    expect(next[5]).toEqual({ ...list, content: [{ type: "listItem", content: [para(text("Open "), text("Plans", { type: "bold" }), text("."))] }, list.content[1]] });
    expect(next[5]!.content![1]).toBe(list.content[1]);
    expect(next.slice(0, 5).every((node, i) => node === section[i])).toBe(true);
  });

  test("a table's cell is a passage too: its text changes, its row, attributes and the other cells kept", () => {
    const next = replacePassage(section, "3", "5")!;
    expect(next[2]).toEqual({ ...table, content: [table.content[0], { type: "tableRow", content: [cell("tableCell", "Free"), cell("tableCell", "5")] }] });
    expect(next[2]!.content![0]).toBe(table.content[0]);
    expect(next[2]!.content![1]!.content![0]).toBe(table.content[1]!.content[0]);
  });

  test("not found, or found twice: refused, never the nearest match", () => {
    const twice = [...section, para(text("Each plan has seats."))];
    expect(replacePassage(section, "Each plan has seat.", "Each plan has a price.")).toBeNull();
    expect(replacePassage(section, "each plan has seats.", "Each plan has a price.")).toBeNull();
    expect(replacePassage(section, "Each plan", "Each plan has a price.")).toBeNull();
    expect(replacePassage(twice, "Each plan has seats.", "Each plan has a price.")).toBeNull();
    // A code block's text is no passage, nor is a block with what can't be written back (italics, a line break).
    expect(replacePassage(section, "npm run export", "npm run exports")).toBeNull();
    expect(passagesIn([para(text("Really", { type: "italic" })), para(text("One"), { type: "hardBreak" }, text("Two")), para()])).toEqual([]);
    expect(passagesIn(section).map((passage) => passage.text)).toEqual(["Plans", "Each plan has seats.", "Plan", "Seats", "Free", "3", "Open **Billing**.", "Pick a plan."]);
  });

  test("the replacement is one line of text, bold and the passage's own links; a link it had can't be lost", () => {
    const docs = { type: "link", attrs: { href: "https://example.com/plans" } };
    const linked = [para(text("See "), text("the plans", docs), text("."))];
    expect(passagesIn(linked)[0]!.text).toBe("See [the plans](https://example.com/plans).");
    expect(replacePassage(linked, "See [the plans](https://example.com/plans).", "Compare [every plan](https://example.com/plans).")![0]).toEqual(
      para(text("Compare "), text("every plan", docs), text(".")),
    );
    expect(replacePassage(linked, "See [the plans](https://example.com/plans).", "Compare every plan.")).toBeNull();
    // A link it didn't have stays text; markup that isn't bold or a link is never a node.
    expect(replacePassage(section, "Each plan has seats.", "See [pricing](https://evil.example/x) and <img src=x> *now*.")![1]!.content).toEqual([
      text("See "),
      text("pricing"),
      text(" and <img src=x> *now*."),
    ]);
    for (const refused of ["", "  ", "Each plan has seats.\n\nAnd a price.", "Each plan has seats.\n- And a price."]) {
      expect(replacePassage(section, "Each plan has seats.", refused)).toBeNull();
    }
  });

  test("inline code is kept as it was: the text around it changes, the code node comes back the same; code changed, dropped, added or moved is refused", () => {
    const run = text("npm run export", { type: "code" });
    const flag = text("--csv", { type: "code" });
    const block = [para(text("Run "), run, text(" with "), flag, text(" to get a file."))];
    const find = "Run `npm run export` with `--csv` to get a file.";
    expect(passagesIn(block)[0]!.text).toBe(find);
    const next = replacePassage(block, find, "Run `npm run export` with `--csv` to download a CSV file.")!;
    expect(next[0]!.content).toEqual([text("Run "), run, text(" with "), flag, text(" to download a CSV file.")]);
    expect(next[0]!.content![1]).toBe(run);
    expect(next[0]!.content![3]).toBe(flag);
    for (const refused of [
      "Run `npm run exports` with `--csv` to get a file.",
      "Run `npm run export` to get a file.",
      "Run `--csv` with `npm run export` to get a file.",
      "Run `npm run export` with `--csv` to get a `file`.",
      "Run `npm run export` with `--csv` and `--csv` to get a file.",
      "Run npm run export with --csv to get a file.",
    ]) {
      expect(replacePassage(block, find, refused)).toBeNull();
    }
    // Code that's also a link or bold is written with the mark around it, so it couldn't be found as it was: no passage.
    const config = { type: "link", attrs: { href: "https://example.com/c" } };
    expect(passagesIn([para(text("Edit "), text("the ", config), text("config.yml", config, { type: "code" }), text(" file", config))])).toEqual([]);
    expect(passagesIn([para(text("acme ", { type: "bold" }), text("theme", { type: "bold" }, { type: "code" }))])).toEqual([]);
    // Bold beside code is one: every passage listed can be replaced by itself.
    const beside = [para(text("Run", { type: "bold" }), text(" "), run, text(" "), text("now", { type: "bold" }))];
    expect(replacePassage(beside, passagesIn(beside)[0]!.text, passagesIn(beside)[0]!.text)![0]).toEqual(beside[0]);
    // A passage without code can't gain any.
    expect(replacePassage(section, "Each plan has seats.", "Each plan has `seats`.")).toBeNull();
  });
});
