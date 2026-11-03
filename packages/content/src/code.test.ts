import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { diffBlocks } from "./diff";
import { parseDoc, toChunks, toPlainText } from "./document";
import { toMarkdown } from "./markdown";
import { CODE_TABS_EDIT, codeTabsGuard, schemaFor } from "./profiles";
import { RichText } from "./react";

const doc = (...content: object[]) => ({ type: "doc", content });
const code = (value: string, attrs: object = {}) => ({ type: "codeBlock", attrs, content: value ? [{ type: "text", text: value }] : [] });
const tabs = (...content: object[]) => ({ type: "codeTabs", content });
const install = tabs(code("npm i tuti", { filename: "npm" }), code("pnpm add tuti", { filename: "pnpm" }), code("yarn add tuti", { filename: "yarn" }));
const parsed = (profile: Parameters<typeof parseDoc>[0], input: object) => {
  const result = parseDoc(profile, input);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.doc;
};

describe("code with a file name, and code tabs", () => {
  test("articles' code blocks keep a file name, trimmed (an empty one is none); posts' and changelog entries' don't get one", () => {
    expect(parsed("article", doc(code("{}", { filename: " package.json " }))).content![0]!.attrs).toEqual({ language: null, filename: "package.json" });
    expect(parsed("article", doc(code("{}", { filename: "  " }))).content![0]!.attrs).toEqual({ language: null, filename: null });
    for (const profile of ["post", "changelog"] as const) {
      expect(parsed(profile, doc(code("{}", { filename: "package.json" }))).content![0]!.attrs).toEqual({ language: null });
    }
  });

  test.each([["a".repeat(81)], ["two\nlines"], ["tab\there"], [42]])("rejects the file name %j", (filename) => {
    expect(parseDoc("article", doc(code("{}", { filename })))).toEqual({
      ok: false,
      error: "A code block's file name is one line of up to 80 characters.",
    });
  });

  test("code tabs: two to eight code blocks, each with a label, in articles only", () => {
    expect(parsed("article", doc(install)).content![0]!.content).toHaveLength(3);
    const tab = (n: number) => code("x", { filename: `Tab ${n}` });
    expect(parseDoc("article", doc(tabs(tab(1)))).ok).toBe(false);
    expect(parseDoc("article", doc(tabs(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(tab)))).ok).toBe(false);
    expect(parseDoc("article", doc(tabs(tab(1), { type: "paragraph" }))).ok).toBe(false);
    expect(parseDoc("article", doc(tabs(tab(1), code("x"))))).toEqual({ ok: false, error: "Each code tab needs a label." });
    expect(parseDoc("article", doc(tabs(tab(1), code("x", { filename: " " }))))).toEqual({ ok: false, error: "Each code tab needs a label." });
    expect(parseDoc("changelog", doc(install)).ok).toBe(false);
    expect(parseDoc("post", doc(install)).ok).toBe(false);
  });

  test("plain text and search have every tab's code, each under its label", () => {
    const article = doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Install" }] }, install, code("{}", { filename: "tuti.json" }));
    expect(toPlainText(install)).toBe("npm\nnpm i tuti\npnpm\npnpm add tuti\nyarn\nyarn add tuti");
    expect(toChunks(article)).toEqual([{ heading: "Install", text: "npm\nnpm i tuti\npnpm\npnpm add tuti\nyarn\nyarn add tuti\n\ntuti.json\n{}" }]);
  });

  test("Markdown: the file name in code on the line above the fence; each tab its own block under its label", () => {
    expect(toMarkdown(doc(code("{}", { filename: "package.json", language: "json" })))).toBe("`package.json`\n\n```json\n{}\n```");
    expect(toMarkdown(doc(install))).toBe("`npm`\n\n```\nnpm i tuti\n```\n\n`pnpm`\n\n```\npnpm add tuti\n```\n\n`yarn`\n\n```\nyarn add tuti\n```");
    // A label is code, never markup; one with backticks gets a longer code span.
    expect(toMarkdown(doc(code("x", { filename: "**a** `b`" })))).toBe("`` **a** `b` ``\n\n```\nx\n```");
    // In a table cell, on one line.
    const table = {
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [install] }] }],
    };
    expect(toMarkdown(doc(table)).split("\n")[0]).toBe("| npm: `npm i tuti` pnpm: `pnpm add tuti` yarn: `yarn add tuti` |");
  });

  test("RichText: a file name in a bar above its code; tabs as radio buttons, the first picked, every tab's code on the page", () => {
    const html = (input: object) => renderToStaticMarkup(createElement(RichText, { doc: input }));
    expect(html(doc(code("{}", { filename: "<b>package.json</b>" })))).toBe(
      '<div><figure class="rich-code"><figcaption>&lt;b&gt;package.json&lt;/b&gt;</figcaption><pre><code>{}</code></pre></figure></div>',
    );
    const out = html(doc(install, install));
    const names = [...out.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    // Each group's radios share a name of their own.
    expect(new Set(names.slice(0, 3)).size).toBe(1);
    expect(names[0]).not.toBe(names[3]);
    expect(out.replaceAll(names[0]!, "N")).toContain(
      '<div class="rich-code-tabs"><div class="rich-code-tab-row"><label><input type="radio" name="N" checked=""/>npm</label><label><input type="radio" name="N"/>pnpm</label><label><input type="radio" name="N"/>yarn</label></div><pre><code>npm i tuti</code></pre><pre><code>pnpm add tuti</code></pre><pre><code>yarn add tuti</code></pre></div>',
    );
  });

  test("History's and Autopilot's diffs: a changed tab shows as itself, not the group (which shows its first tab)", () => {
    const changed = tabs(code("npm i tuti", { filename: "npm" }), code("pnpm add tuti@2", { filename: "pnpm" }), code("yarn add tuti", { filename: "yarn" }));
    expect(diffBlocks(doc(install), doc(changed)).map(({ kind, doc }) => [kind, toPlainText(doc)])).toEqual([
      ["same", "npm\nnpm i tuti"],
      ["removed", "pnpm\npnpm add tuti"],
      ["added", "pnpm\npnpm add tuti@2"],
      ["same", "yarn\nyarn add tuti"],
    ]);
  });
});

test("in the editor, an edit of the text can't join tabs or leave one without a label; the tabs' own edits can", () => {
  // A selection from the paragraph above into the second tab takes the tabs it covers out, like any block it runs
  // into, and joins the rest onto the paragraph: no tab is left without a label.
  const above = EditorState.create({
    doc: schemaFor("article").nodeFromJSON(
      doc({ type: "paragraph", content: [{ type: "text", text: "Install it:" }] }, tabs(code("npm i tuti", { filename: "npm" }), code("pnpm add tuti", { filename: "pnpm" }))),
    ),
    plugins: [codeTabsGuard()],
  });
  const intoSecond = 13 + 1 + 1 + "npm i tuti".length + 2 + 4;
  for (const tr of [above.tr.setSelection(TextSelection.create(above.doc, 5, intoSecond)).deleteSelection(), above.tr.insertText("x", 5, intoSecond)]) {
    expect(above.applyTransaction(tr).state.doc.toJSON()).toMatchObject(doc({ type: "paragraph" }));
  }

  const state = EditorState.create({ doc: schemaFor("article").nodeFromJSON(doc(install)), plugins: [codeTabsGuard()] });
  const applied = (tr: ReturnType<typeof state.tr.delete>) => state.applyTransaction(tr).state.doc.toJSON() as object;
  const unchanged = state.doc.toJSON() as object;
  // Positions: the group starts at 0, its first tab at 1, that tab's text at 2.
  const firstText = 2;
  const secondText = firstText + "npm i tuti".length + 2;
  // A selection from the first tab into the second, deleted or typed over.
  expect(applied(state.tr.delete(firstText + 4, secondText + 4))).toEqual(unchanged);
  expect(applied(state.tr.insertText("x", firstText + 4, secondText + 4))).toEqual(unchanged);
  // Typing in a tab is fine; so is a tab's own edit, and deleting the whole group.
  expect(applied(state.tr.insertText("x", firstText))).not.toEqual(unchanged);
  expect(applied(state.tr.delete(firstText - 1, secondText - 1).setMeta(CODE_TABS_EDIT, true))).not.toEqual(unchanged);
  expect(applied(state.tr.delete(0, state.doc.content.size))).not.toEqual(unchanged);
});

test("a diff shows code put into tabs, or taken out of them, as changed", () => {
  const blocks = [code("npm i tuti", { filename: "npm" }), code("pnpm add tuti", { filename: "pnpm" })];
  const kinds = (before: object, after: object) => diffBlocks(before, after).map(({ kind }) => kind);
  expect(kinds(doc(...blocks), doc(tabs(...blocks)))).toEqual(["removed", "removed", "added", "added"]);
  expect(kinds(doc(tabs(...blocks)), doc(tabs(...blocks)))).toEqual(["same", "same"]);
});
