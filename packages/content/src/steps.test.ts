import type { JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { docHeadings, parseDoc, toChunks, toPlainText } from "./document";
import { toMarkdown } from "./markdown";
import { joinStep, nextStep, schemaFor } from "./profiles";
import { RichText } from "./react";
import { sections } from "./sections";

const doc = (...content: object[]) => ({ type: "doc", content });
const p = (...content: object[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks && { marks }) });
const title = (...content: object[]) => ({ type: "stepTitle", content });
const step = (...content: object[]) => ({ type: "step", content });
const steps = (...content: object[]) => ({ type: "steps", content });
const bold = { type: "bold" };

const install = steps(
  step(title(text("Open "), text("Settings", [bold])), p(text("Find it in the menu.")), {
    type: "bulletList",
    content: [{ type: "listItem", content: [p(text("Or press ,"))] }],
  }),
  step(title(text("Copy the key")), { type: "codeBlock", attrs: { language: "bash" }, content: [text("tuti login\ntuti keys")] }),
  step(title(text("Done"))),
);

describe("steps", () => {
  test("articles have them; other profiles don't", () => {
    expect(parseDoc("article", doc(install))).toMatchObject({ ok: true });
    for (const profile of ["changelog", "post", "comment"] as const) {
      expect(parseDoc(profile, doc(install))).toMatchObject({ ok: false });
    }
  });

  test.each([
    ["a step outside steps", doc(step(title(text("A"))))],
    ["steps with no step", doc(steps())],
    ["a step without a title", doc(steps(step(p(text("A")))))],
    ["two titles", doc(steps(step(title(text("A")), title(text("B")))))],
    ["a heading in a step", doc(steps(step(title(text("A")), { type: "heading", attrs: { level: 2 }, content: [text("B")] })))],
    ["a table in a step", doc(steps(step(title(text("A")), { type: "table", content: [] })))],
    ["a title outside a step", doc(title(text("A")))],
  ])("rejects %s", (_name, input) => {
    expect(parseDoc("article", input)).toMatchObject({ ok: false });
  });

  test("drops attributes nobody set", () => {
    const result = parseDoc("article", doc({ ...steps({ ...step(title(text("A"))), attrs: { onclick: "x" } }), attrs: { class: "x" } }));
    expect(result).toEqual({ ok: true, doc: doc(steps(step(title(text("A"))))) });
  });

  test("plain text numbers each step, its body on the lines after", () => {
    expect(toPlainText(doc(p(text("Before")), install, p(text("After"))))).toBe(
      "Before\n1. Open Settings\nFind it in the menu.\nOr press ,\n2. Copy the key\ntuti login\ntuti keys\n3. Done\nAfter",
    );
    expect(toChunks(doc(install))[0]!.text).toContain("2. Copy the key");
  });

  test("Markdown: a numbered list, each item its title in bold and the body indented under it", () => {
    expect(toMarkdown(doc(install))).toBe(
      [
        "1) **Open Settings**",
        "",
        "   Find it in the menu.",
        "",
        "   - Or press ,",
        "",
        "2) **Copy the key**",
        "",
        "   ```bash",
        "   tuti login",
        "   tuti keys",
        "   ```",
        "",
        "3) **Done**",
      ].join("\n"),
    );
    // Markup in a title stays text.
    expect(toMarkdown(doc(steps(step(title(text("1. *x*"))))))).toBe("1) **1. \\*x\\***");
    // A numbered list right after is a list of its own.
    const list = { type: "orderedList", content: [{ type: "listItem", content: [p(text("Mac"))] }] };
    expect(toMarkdown(doc(steps(step(title(text("Install")))), list))).toBe("1) **Install**\n\n1. Mac");
    // And steps right after steps.
    expect(toMarkdown(doc(steps(step(title(text("Install")))), steps(step(title(text("Mac"))))))).toBe("1) **Install**\n\n<!-- -->\n\n1) **Mac**");
  });

  test("renders as a list of numbered steps, each a title and its body", () => {
    const html = renderToStaticMarkup(createElement(RichText, { doc: doc(steps(step(title(text("Open")), p(text("Then"))), step(title(text("Save"))))) }));
    expect(html).toBe(
      '<div><ol class="rich-steps" role="list"><li><p class="rich-step-title">Open</p><p>Then</p></li><li><p class="rich-step-title">Save</p></li></ol></div>',
    );
  });

  test("stay inside their section: no headings for On this page", () => {
    const article = doc({ type: "heading", attrs: { level: 2 }, content: [text("Setup")] }, install);
    expect(docHeadings(article).map((heading) => heading.text)).toEqual(["Setup"]);
    expect(sections(article.content)).toHaveLength(1);
  });
});

describe("steps in the editor", () => {
  const schema = schemaFor("article");
  /** The state with the cursor at the `n`th text position (counting from the end when negative) inside the node `at` finds. */
  const stateAt = (content: JSONContent, at: (node: JSONContent) => boolean, offset = 0) => {
    const node = schema.nodeFromJSON(content);
    let pos = -1;
    node.descendants((child, childPos) => {
      if (pos === -1 && at(child.toJSON() as JSONContent)) {
        pos = childPos + 1 + (offset < 0 ? child.content.size + offset + 1 : offset);
      }
    });
    return EditorState.create({ doc: node, selection: TextSelection.create(node, pos) });
  };
  const run = (state: EditorState, command: typeof nextStep) => {
    let next = state;
    const handled = command(state, (tr) => (next = state.apply(tr)));
    return { handled, doc: next.doc.toJSON() as JSONContent, parent: next.selection.$from.parent.type.name };
  };
  const empty = (type: string) => (node: JSONContent) => node.type === type && !node.content;

  test("Enter on a step's empty last line starts the next step, its title next", () => {
    const state = stateAt(doc(steps(step(title(text("A")), p(text("Body")), p()))), empty("paragraph"));
    expect(run(state, nextStep)).toEqual({
      handled: true,
      doc: doc(steps(step(title(text("A")), p(text("Body"))), step({ type: "stepTitle" }))),
      parent: "stepTitle",
    });
  });

  test("Enter on the empty title of a new last step leaves the steps", () => {
    const state = stateAt(doc(steps(step(title(text("A"))), step({ type: "stepTitle" }))), empty("stepTitle"));
    expect(run(state, nextStep)).toEqual({ handled: true, doc: doc(steps(step(title(text("A")))), { type: "paragraph" }), parent: "paragraph" });
  });

  test("Enter elsewhere is the editor's own", () => {
    expect(run(stateAt(doc(steps(step(title(text("A")), p(text("B"))))), (n) => n.type === "paragraph", -1), nextStep).handled).toBe(false);
    expect(run(stateAt(doc(p()), empty("paragraph")), nextStep).handled).toBe(false);
  });

  test("Backspace at a title's start joins the step to the one before", () => {
    const state = stateAt(doc(steps(step(title(text("A"))), step(title(text("B")), p(text("C"))))), (n) => n.type === "stepTitle" && toPlainText(n) === "B");
    expect(run(state, joinStep)).toEqual({ handled: true, doc: doc(steps(step(title(text("A")), p(text("B")), p(text("C"))))), parent: "paragraph" });
  });

  test("Backspace on the first step moves it above the block; on the only empty step, the block goes", () => {
    const first = stateAt(doc(steps(step(title(text("A"))), step(title(text("B"))))), (n) => n.type === "stepTitle");
    expect(run(first, joinStep).doc).toEqual(doc(p(text("A")), steps(step(title(text("B"))))));
    const only = stateAt(doc(steps(step({ type: "stepTitle" }, { type: "paragraph" }))), empty("stepTitle"));
    expect(run(only, joinStep).doc).toEqual(doc({ type: "paragraph" }));
  });

  test("Backspace on an empty step takes it out, the cursor at the end of the one before", () => {
    const state = stateAt(doc(steps(step(title(text("A")), p(text("B"))), step({ type: "stepTitle" }))), empty("stepTitle"));
    expect(run(state, joinStep)).toEqual({ handled: true, doc: doc(steps(step(title(text("A")), p(text("B"))))), parent: "paragraph" });
  });
});
