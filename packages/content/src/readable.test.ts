import { expect, test } from "vitest";

import { parseDoc } from "./document";
import { schemaFor } from "./profiles";
import { readableBy, readablePart } from "./readable";

const p = (text: string, attrs?: object) => ({ type: "paragraph", ...(attrs && { attrs }), content: [{ type: "text", text }] });
const doc = (...content: object[]) => ({ type: "doc", content });
// A block this release's article schema doesn't have (as a newer release might save).
const callout = { type: "callout", attrs: { tone: "info" }, content: [p("Heads up")] };

test("text an editor knows all of is readable; an unknown block, mark or attribute, or one out of place, isn't", () => {
  const article = schemaFor("article");
  expect(readableBy(article, doc(p("Welcome."), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Setup" }] }))).toBe(true);
  expect(readableBy(article, doc(p("Welcome."), callout))).toBe(false);
  expect(readableBy(article, doc({ type: "paragraph", content: [{ type: "text", text: "Hi", marks: [{ type: "highlight" }] }] }))).toBe(false);
  // A new attribute on a block it knows: ProseMirror would drop it quietly, and a save would lose it.
  expect(readableBy(article, doc(p("Welcome.", { textAlign: "center" })))).toBe(false);
  // Known, but where this release doesn't allow it (a heading in a post).
  expect(readableBy(schemaFor("post"), doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Setup" }] }))).toBe(false);
});

test("the readable part leaves out what the editor doesn't know, so the rest can still be read", () => {
  const article = schemaFor("article");
  expect(readablePart(article, doc(p("Welcome."), callout))).toEqual(doc(p("Welcome.")));
  expect(readablePart(article, doc(p("Welcome.", { textAlign: "center" })))).toEqual(doc(p("Welcome.")));
  // A container left empty is filled as the schema needs, so the text around it still shows.
  const details = (...body: object[]) => ({ type: "details", content: [{ type: "detailsSummary", content: [{ type: "text", text: "Q" }] }, { type: "detailsContent", content: body }] });
  for (const container of [details(callout), { type: "blockquote", content: [callout] }]) {
    const part = readablePart(article, doc(p("Intro"), container, p("More"))) as { content: { type: string }[] };
    expect(part.content.map((node) => node.type)).toEqual(["paragraph", container.type, "paragraph"]);
  }
  // A table cell holding only an unknown block keeps its row.
  const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [callout] }] }] };
  expect((readablePart(article, doc(p("Intro"), table)) as { content: object[] }).content).toHaveLength(2);
});

test("everything this release saves is readable by its own editor (no false alarms)", () => {
  const id = "clx0abcdefghijklmnopqrstu";
  const t = (text: string, marks?: object[]) => ({ type: "text", text, ...(marks && { marks }) });
  const code = (text: string, filename?: string) => ({ type: "codeBlock", attrs: { language: "bash", ...(filename && { filename }) }, content: [t(text)] });
  const cell = (type: string, text: string) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(text)] });
  const every = doc(
    { type: "paragraph", content: [t("Bold", [{ type: "bold" }]), t(" italic", [{ type: "italic" }]), t(" code", [{ type: "code" }]), t(" link", [{ type: "link", attrs: { href: "https://example.com" } }])] },
    { type: "tableOfContents" },
    { type: "heading", attrs: { level: 2 }, content: [t("Install")] },
    { type: "codeTabs", content: [code("npm i acme", "npm"), code("pnpm add acme", "pnpm")] },
    code("{}", "acme.json"),
    { type: "steps", content: [{ type: "step", content: [{ type: "stepTitle", content: [t("Create a project")] }, p("Pick a name.")] }] },
    { type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", "Plan"), cell("tableHeader", "Price")] }, { type: "tableRow", content: [cell("tableCell", "Free"), cell("tableCell", "$0")] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p("Open Settings")] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [p("One")] }] },
    { type: "blockquote", content: [p("Quoted")] },
    { type: "horizontalRule" },
    { type: "details", content: [{ type: "detailsSummary", content: [t("Can I export?")] }, { type: "detailsContent", content: [p("Yes.")] }] },
    { type: "image", attrs: { mediaId: id, width: "50", align: "left", alt: "Dashboard", w: 1200, h: 800 } },
    { type: "file", attrs: { mediaId: id, name: "Price list.pdf", size: 1234 } },
    { type: "video", attrs: { provider: "youtube", id: "aqz-KE-bpKQ" } },
  );
  const stored = parseDoc("article", every);
  expect(stored.ok).toBe(true);
  expect(readableBy(schemaFor("article"), (stored as { doc: object }).doc)).toBe(true);
  const post = parseDoc("post", doc(p("A post"), { type: "image", attrs: { mediaId: id, width: "100", align: "center", alt: "", w: 10, h: 10 } }));
  expect(readableBy(schemaFor("post"), (post as { doc: object }).doc)).toBe(true);
});
