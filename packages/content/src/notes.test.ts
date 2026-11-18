import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";

import { insertAfterPassage, passagesIn, readNotes, replacePassage } from "./notes";

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
    // A code block is quoted whole, fenced: its code alone isn't found. An empty block is no passage.
    expect(replacePassage(section, "npm run export", "npm run exports")).toBeNull();
    expect(passagesIn([para(), { type: "codeBlock", attrs: { language: null }, content: [] }])).toEqual([]);
    expect(passagesIn(section).map((passage) => passage.text)).toEqual(["Plans", "Each plan has seats.", "Plan", "Seats", "Free", "3", "```bash\nnpm run export\n```", "Open **Billing**.", "Pick a plan."]);
  });

  test("the replacement is one line of text, bold and the passage's own links; a link it had can't be lost", () => {
    const docs = { type: "link", attrs: { href: "https://example.com/plans" } };
    const linked = [para(text("See "), text("the plans", docs), text("."))];
    expect(passagesIn(linked)[0]!.text).toBe("See [the plans](https://example.com/plans).");
    expect(replacePassage(linked, "See [the plans](https://example.com/plans).", "Compare [every plan](https://example.com/plans).")![0]).toEqual(
      para(text("Compare "), text("every plan", docs), text(".")),
    );
    expect(replacePassage(linked, "See [the plans](https://example.com/plans).", "Compare every plan.")).toBeNull();
    // A link it didn't have stays text; markup that isn't bold, italics or a link is never a node.
    expect(replacePassage(section, "Each plan has seats.", "See [pricing](https://evil.example/x) and <img src=x> *now*, 2 * 3 \\*4\\*.")![1]!.content).toEqual([
      text("See "),
      text("pricing"),
      text(" and <img src=x> "),
      text("now", { type: "italic" }),
      text(", 2 * 3 *4*."),
    ]);
    for (const refused of ["Each plan has seats.\n\nAnd a price.", "Each plan has seats.\n- And a price."]) {
      expect(replacePassage(section, "Each plan has seats.", refused)).toBeNull();
    }
  });

  test("inline code keeps its place: what's in a span may change (a renamed flag), its marks kept; code dropped, added or made from text is refused", () => {
    const run = text("npm run export", { type: "code" });
    const flag = text("--csv", { type: "code" });
    const block = [para(text("Run "), run, text(" with "), flag, text(" to get a file."))];
    const find = "Run `npm run export` with `--csv` to get a file.";
    expect(passagesIn(block)[0]!.text).toBe(find);
    const next = replacePassage(block, find, "Run `npm run export` with `--csv` to download a CSV file.")!;
    expect(next[0]!.content).toEqual([text("Run "), run, text(" with "), flag, text(" to download a CSV file.")]);
    expect(next[0]!.content![1]).toBe(run);
    expect(next[0]!.content![3]).toBe(flag);
    // A span's code changed, as Markdown writes it (more backticks around a backtick, a space inside each end).
    expect(replacePassage(block, find, "Run `npm run download` with `` --format `csv` `` to get a file.")![0]!.content).toEqual([
      text("Run "),
      text("npm run download", { type: "code" }),
      text(" with "),
      text("--format `csv`", { type: "code" }),
      text(" to get a file."),
    ]);
    for (const refused of [
      "Run `npm run export` to get a file.",
      "Run `npm run export` with `--csv` to get a `file`.",
      "Run `npm run export` with `--csv` and `--csv` to get a file.",
      "Run npm run export with --csv to get a file.",
      "Run `npm run export` with `` to get a file.",
      "Run `npm run export` with `--csv to get a file.",
    ]) {
      expect(replacePassage(block, find, refused)).toBeNull();
    }
    // Text in two marks at once is no passage. Code that's also a link or bold is written with the mark around it, so it couldn't be found as it was.
    const config = { type: "link", attrs: { href: "https://example.com/c" } };
    expect(passagesIn([para(text("Edit "), text("the ", config), text("config.yml", config, { type: "code" }), text(" file", config))])).toEqual([]);
    expect(passagesIn([para(text("acme ", { type: "bold" }), text("theme", { type: "bold" }, { type: "code" }))])).toEqual([]);
    // So is a bold link: read back, it would keep its link and lose its bold.
    expect(passagesIn([para(text("Open "), text("Settings", config, { type: "bold" }), text("."))])).toEqual([]);
    // Nor is text Markdown writes in a way the reply's reader doesn't read back: a link with a bracket in its address or
    // its words, a backtick outside code. Listed, it could only ever be refused.
    const wiki = { type: "link", attrs: { href: "https://example.com/wiki/Theme_(app)" } };
    expect(passagesIn([para(text("See "), text("themes", wiki), text("."))])).toEqual([]);
    expect(passagesIn([para(text("See "), text("the [new] themes", config), text("."))])).toEqual([]);
    expect(passagesIn([para(text("Press the ` key."))])).toEqual([]);
    // Other escaped text is: it's read back as it was.
    const escaped = [para(text("1. Use snake_case, *not* <b> or [x] | y & z."))];
    expect(replacePassage(escaped, passagesIn(escaped)[0]!.text, passagesIn(escaped)[0]!.text)).toEqual(escaped);
    // Bold beside code is one: every passage listed can be replaced by itself.
    const beside = [para(text("Run", { type: "bold" }), text(" "), run, text(" "), text("now", { type: "bold" }))];
    expect(replacePassage(beside, passagesIn(beside)[0]!.text, passagesIn(beside)[0]!.text)![0]).toEqual(beside[0]);
    // A passage without code can't gain any.
    expect(replacePassage(section, "Each plan has seats.", "Each plan has `seats`.")).toBeNull();
  });

  test("a replacement with a carriage return is more than one line: refused, like a line feed", () => {
    expect(replacePassage(section, "Plans", "New label\rDetails")).toBeNull();
    expect(replacePassage(section, "Each plan has seats.", "Each plan has seats.\r\nAnd a price.")).toBeNull();
  });

  test("a link as the editor stores it (target, rel and all) is a passage, and its replacement keeps the link's every attribute", () => {
    const link = { type: "link", attrs: { href: "https://example.com/billing", target: "_blank", rel: "noopener noreferrer nofollow", class: null } };
    const stored = [{ type: "paragraph", content: [{ type: "text", text: "See " }, { type: "text", text: "Billing", marks: [link] }, { type: "text", text: " for seats." }] }];
    expect(passagesIn(stored).map((passage) => passage.text)).toEqual(["See [Billing](https://example.com/billing) for seats."]);
    const next = replacePassage(stored, "See [Billing](https://example.com/billing) for seats.", "See [Plans](https://example.com/billing) for seats and prices.")!;
    expect(next[0]!.content).toEqual([{ type: "text", text: "See " }, { type: "text", text: "Plans", marks: [link] }, { type: "text", text: " for seats and prices." }]);
  });

  test("links and bold are read with a length limit on each part: an address as long as a link may be is still a link, and what's over a limit is text", () => {
    const long = `https://example.com/?q=${"a".repeat(2048 - "https://example.com/?q=".length)}`;
    const read = (notes: string) => readNotes(JSON.stringify({ notes }), new Set([long]), [])!.doc.content;
    expect(read(`See [Billing](${long}).`)![0]!.content![1]).toEqual({ type: "text", text: "Billing", marks: [{ type: "link", attrs: { href: long } }] });
    // Over a limit, or nothing but brackets: read as the text it is, no link made.
    expect(JSON.stringify(read(`See [${"b".repeat(1001)}](${long}).`))).not.toContain('"link"');
    expect(JSON.stringify(read("[".repeat(5000)))).not.toContain('"link"');
  });

  test("a replacement with an image's placeholder is refused: the image stays where it is, and the placeholder would be stored as text", () => {
    expect(replacePassage(section, "Each plan has seats.", "Each plan has seats. {{media 1}}")).toBeNull();
    expect(replacePassage(section, "Each plan has seats.", "Each plan has seats. \\{\\{media 1\\}\\}")).toBeNull();
    expect(replacePassage(section, "Each plan has seats.", "Each plan has five seats.")).not.toBeNull();
  });

  test("a replacement that starts with a block's marker is refused: it would be stored as text, not read as a block", () => {
    // A list's item would read "2. 1. Open Plans.", a heading would show its hashes.
    expect(replacePassage(section, "Open **Billing**.", "1. Open **Plans**.")).toBeNull();
    expect(replacePassage(section, "Plans", "## Export to CSV")).toBeNull();
    // A divider, and a marker with nothing after it, are blocks too.
    expect(replacePassage(section, "Plans", "---")).toBeNull();
    expect(replacePassage(section, "Plans", "1.")).toBeNull();
    for (const refused of ["- Each plan has a price.", "* Each plan has a price.", "+ Each plan has a price.", "2) Each plan has a price.", "> Each plan has a price.", "# Plans"]) {
      expect(replacePassage(section, "Each plan has seats.", refused)).toBeNull();
    }
    // Escaped, or no marker at all (bold, a number in a sentence), it's text.
    expect(replacePassage(section, "Each plan has seats.", "1\\. Use a plan.")![1]!.content).toEqual([text("1. Use a plan.")]);
    expect(replacePassage(section, "Each plan has seats.", "**Each** plan has 3.5 seats.")).not.toBeNull();
  });

  test("two links to one address are two links: a replacement that keeps one and makes the other plain text is refused", () => {
    const docs = { type: "link", attrs: { href: "https://example.com/docs" } };
    const twice = [para(text("Read "), text("Setup", docs), text(" and "), text("Export", docs), text("."))];
    const find = "Read [Setup](https://example.com/docs) and [Export](https://example.com/docs).";
    expect(passagesIn(twice)[0]!.text).toBe(find);
    expect(replacePassage(twice, find, "Read [Setup](https://example.com/docs) and Export.")).toBeNull();
    // Their words may change.
    expect(replacePassage(twice, find, "Read [Set up](https://example.com/docs), then [Exports](https://example.com/docs).")![0]).toEqual(
      para(text("Read "), text("Set up", docs), text(", then "), text("Exports", docs), text(".")),
    );
  });

  test("italics and line breaks are passages too: listed as *italics* and <br>, each kept or changed in the replacement", () => {
    const italic = { type: "italic" };
    const block = [para(text("Exports are "), text("never", italic), text(" emailed."), { type: "hardBreak" }, text("Find them in "), text("Files", { type: "bold" }), text("."))];
    const find = "Exports are *never* emailed.<br>Find them in **Files**.";
    expect(passagesIn(block).map((passage) => passage.text)).toEqual([find]);
    // Read back as it was, so it's listed.
    expect(replacePassage(block, find, find)).toEqual(block);
    expect(replacePassage(block, find, "Exports are *always* emailed.<br>Find them in **Downloads** too.")![0]).toEqual(
      para(text("Exports are "), text("always", italic), text(" emailed."), { type: "hardBreak" }, text("Find them in "), text("Downloads", { type: "bold" }), text(" too.")),
    );
    // A line break dropped is a change like any other; an escaped <br> is text, never a break.
    expect(replacePassage(block, find, "Exports are *never* emailed.")![0]).toEqual(para(text("Exports are "), text("never", italic), text(" emailed.")));
    expect(replacePassage(block, find, "Use \\<br> tags.")![0]).toEqual(para(text("Use <br> tags.")));
    // A break at either end is refused: Markdown doesn't write one at the end, so the block couldn't be found again.
    expect(replacePassage(block, find, "Exports are *never* emailed.<br>")).toBeNull();
    expect(replacePassage(block, find, "<br>Exports are *never* emailed.")).toBeNull();
    // Still one line: a real line feed is refused, as before.
    expect(replacePassage(block, find, "Exports are *never* emailed.\nFind them in **Files**.")).toBeNull();
    // A break at the end isn't written back by Markdown, and bold italics keep one mark per run: neither is listed.
    expect(passagesIn([para(text("One"), { type: "hardBreak" })])).toEqual([]);
    expect(passagesIn([para(text("Very", { type: "bold" }, italic))])).toEqual([]);
  });

  test("a code block is a passage, fenced: its code replaced by a fenced block, its language and file name kept", () => {
    const block = { type: "codeBlock", attrs: { language: "bash", filename: "export.sh" }, content: [text("npm run export\nls out")] };
    const blocks = [para(text("Run:")), block];
    const find = "```bash\nnpm run export\nls out\n```";
    expect(passagesIn(blocks).map((passage) => passage.text)).toEqual(["Run:", find]);
    // Whatever language its fence names, the block's is kept.
    const next = replacePassage(blocks, find, "```sh\nnpm run download\nls out\n```")!;
    expect(next[1]).toEqual({ type: "codeBlock", attrs: { language: "bash", filename: "export.sh" }, content: [text("npm run download\nls out")] });
    expect(next[0]).toBe(blocks[0]);
    // Not fenced, or blank inside: refused.
    for (const refused of ["npm run download", "```bash\n\n```", "```bash\nnpm run download"]) {
      expect(replacePassage(blocks, find, refused)).toBeNull();
    }
  });

  test("an empty replacement takes the passage out: a paragraph, a heading, a code block or a list's item; a cell or a step's title stays", () => {
    const list = section[5] as JSONContent;
    expect(replacePassage(section, "Each plan has seats.", "")).toEqual([section[0], section[2], section[3], section[4], section[5]]);
    expect(replacePassage(section, "```bash\nnpm run export\n```", " ")).toEqual([section[0], section[1], section[2], section[4], section[5]]);
    expect(replacePassage(section, "Open **Billing**.", "")![5]).toEqual({ ...list, content: [list.content![1]] });
    // One with a link isn't: the link would be lost, which no edit may do.
    const linked = [para(text("See "), text("Billing", { type: "link", attrs: { href: "https://example.com/billing" } }), text(".")), para(text("More."))];
    expect(replacePassage(linked, "See [Billing](https://example.com/billing).", "")).toBeNull();
    expect(replacePassage(linked, "More.", "")).toEqual([linked[0]]);
    // Its list's last item takes the list with it.
    const one = [para(text("Plans:")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("Free"))] }] }];
    expect(replacePassage(one, "Free", "")).toEqual([one[0]]);
    expect(replacePassage(section, "Plans", "")).toEqual(section.slice(1));
    // A cell or a step's title has no place to leave; an item with more than its text ("Pick a plan." has a list under
    // it) would lose that too.
    const steps = [{ type: "steps", content: [{ type: "step", content: [{ type: "stepTitle", content: [text("Open Billing")] }] }] }];
    for (const [blocks, find] of [[section, "3"], [section, "Pick a plan."], [steps, "Open Billing"]] as const) {
      expect(replacePassage(blocks as JSONContent[], find, "")).toBeNull();
    }
  });

  test("text is added after a passage: paragraphs after its block, or items of its list after a list's item", () => {
    const next = insertAfterPassage(section, "Each plan has seats.", "Seats can be added at any time.\n\nSee **Billing**.")!;
    expect(next.slice(0, 4)).toEqual([section[0], section[1], para(text("Seats can be added at any time.")), para(text("See "), text("Billing", { type: "bold" }), text("."))]);
    expect(next.slice(4)).toEqual(section.slice(2));
    // Italics, as in a passage.
    expect(insertAfterPassage(section, "Each plan has seats.", "Seats are *per project*.")![2]).toEqual(para(text("Seats are "), text("per project", { type: "italic" }), text(".")));
    // After a heading, and after a code block.
    expect(insertAfterPassage(section, "Plans", "Pick one.")!.slice(0, 2)).toEqual([section[0], para(text("Pick one."))]);
    expect(insertAfterPassage(section, "```bash\nnpm run export\n```", "It writes a CSV file.")![4]).toEqual(para(text("It writes a CSV file.")));
    // After a list's item, the new items join its list, whatever their marker; the list keeps its kind and start.
    const list = section[5] as JSONContent;
    expect(insertAfterPassage(section, "Open **Billing**.", "1. Pick **Plans**.")![5]).toEqual({
      ...list,
      content: [list.content![0], { type: "listItem", content: [para(text("Pick "), text("Plans", { type: "bold" }), text("."))] }, list.content![1]],
    });
    // Only the links these blocks have; others stay text.
    const linked = [para(text("See "), text("plans", { type: "link", attrs: { href: "https://example.com/plans" } }), text(".")), section[3]];
    expect(insertAfterPassage(linked as JSONContent[], "```bash\nnpm run export\n```", "[Plans](https://example.com/plans) or [this](https://evil.example).")![2]).toEqual(
      para(text("Plans", { type: "link", attrs: { href: "https://example.com/plans" } }), text(" or "), text("this"), text(".")),
    );
    for (const [after, insert] of [
      // Not found once, or no place to add (a cell, an item with more than its text).
      ["Each plan", "More."],
      ["3", "More."],
      ["Pick a plan.", "- More."],
      // Nothing, a heading (it would start a section), an image's placeholder, or more than items after an item.
      ["Each plan has seats.", "  "],
      ["Each plan has seats.", "## Prices\n\nMore."],
      ["Each plan has seats.", "{{media 1}}"],
      ["Open **Billing**.", "Pick a plan."],
      ["Open **Billing**.", "- Pick a plan.\n\nThen pay."],
      // Code: none is made up (its backticks would be dropped, the code shown as text).
      ["Each plan has seats.", "Run `npm run seats` to list them."],
    ]) {
      expect(insertAfterPassage(section, after!, insert!)).toBeNull();
    }
  });
});
