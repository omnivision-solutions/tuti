import { describe, expect, test } from "vitest";

import { parseDoc } from "./document";
import { toMarkdown } from "./markdown";

const doc = (...content: object[]) => ({ type: "doc", content });
const p = (...content: object[]) => ({ type: "paragraph", content });
const text = (value: string, ...marks: object[]) => ({ type: "text", text: value, ...(marks.length > 0 && { marks }) });
const bold = { type: "bold" };
const italic = { type: "italic" };
const code = { type: "code" };
const link = (href: string) => ({ type: "link", attrs: { href } });
const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const item = (...content: object[]) => ({ type: "listItem", content });
const cell = (type: string, value: string, attrs: object = {}) => ({ type, attrs: { colspan: 1, rowspan: 1, ...attrs }, content: [p(text(value))] });
const row = (...content: object[]) => ({ type: "tableRow", content });
const MEDIA_ID = "clx0abcdefghijklmnopqrstu";

describe("toMarkdown", () => {
  test("headings keep their level", () => {
    expect(toMarkdown(doc(heading(2, "Setup"), heading(3, "Keys")))).toBe("## Setup\n\n### Keys");
  });

  test("paragraphs are separated by a blank line; hard breaks stay line breaks", () => {
    expect(toMarkdown(doc(p(text("One")), p(), p(text("Two"), { type: "hardBreak" }, text("three"))))).toBe("One\n\nTwo\\\nthree");
  });

  test("bold, italic, code and links, also across text nodes", () => {
    const out = toMarkdown(
      doc(
        p(
          text("Use "),
          text("bold ", bold),
          text("and italic", bold, italic),
          text(", "),
          text("x = `y`", code),
          text(" or "),
          text("the docs", link("https://example.com/a (b)")),
        ),
      ),
    );
    expect(out).toBe("Use **bold _and italic_**, `` x = `y` `` or [the docs](https://example.com/a%20%28b%29)");
  });

  test("unsafe links are text", () => {
    expect(toMarkdown(doc(p(text("click", link("javascript:alert(1)")))))).toBe("click");
  });

  test("text that looks like markup is escaped", () => {
    const out = toMarkdown(doc(p(text("# not a heading")), p(text("1. not a list")), p(text("a *b* [c](d) <script> snake_case \\"))));
    expect(out).toBe("\\# not a heading\n\n1\\. not a list\n\na \\*b\\* \\[c\\](d) \\<script> snake\\_case \\\\");
  });

  test("bullet and ordered lists, nested", () => {
    const out = toMarkdown(
      doc(
        { type: "bulletList", content: [item(p(text("One")), { type: "bulletList", content: [item(p(text("Inner")))] }), item(p(text("Two")))] },
        { type: "orderedList", attrs: { start: 9 }, content: [item(p(text("Nine")), p(text("More"))), item(p(text("Ten")))] },
      ),
    );
    expect(out).toBe("- One\n  - Inner\n- Two\n\n9. Nine\n\n   More\n10. Ten");
  });

  test("code blocks are fenced, with their language and longer fences when they contain one", () => {
    const block = (value: string, language: string | null) => ({ type: "codeBlock", attrs: { language }, content: [text(value)] });
    expect(toMarkdown(doc(block("npm i *x*", "bash")))).toBe("```bash\nnpm i *x*\n```");
    expect(toMarkdown(doc(block("```\nhi\n```", "not a language!")))).toBe("````\n```\nhi\n```\n````");
  });

  test("quotes and dividers", () => {
    expect(toMarkdown(doc({ type: "blockquote", content: [p(text("Finally!")), p(text("Really."))] }, { type: "horizontalRule" }))).toBe(
      "> Finally!\n>\n> Really.\n\n---",
    );
  });

  test("images from the media host, with their alt text; left out without it", () => {
    const image = doc({ type: "image", attrs: { mediaId: MEDIA_ID, width: "50", align: "center", alt: "A [chart]", w: 1200, h: 800 } });
    expect(toMarkdown(image, { mediaBaseUrl: "https://media.example" })).toBe(`![A \\[chart\\]](https://media.example/m/${MEDIA_ID}/960.webp)`);
    expect(toMarkdown(image)).toBe("");
  });

  test("video embeds link to the video's page", () => {
    expect(toMarkdown(doc({ type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } }))).toBe(
      "[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
    );
    expect(toMarkdown(doc({ type: "video", attrs: { provider: "evil", id: "x" } }))).toBe("");
  });

  test("tables, with the first row as the header, pipes escaped and spanned columns kept aligned", () => {
    const table = {
      type: "table",
      content: [
        row(cell("tableHeader", "Role"), cell("tableHeader", "Can invite"), cell("tableHeader", "Note")),
        row(cell("tableCell", "Admin", { colspan: 2 }), cell("tableCell", "a | b")),
        row(cell("tableCell", "Member")),
      ],
    };
    expect(toMarkdown(doc(table))).toBe(
      "| Role | Can invite | Note |\n| --- | --- | --- |\n| Admin |  | a \\| b |\n| Member |  |  |",
    );
  });

  test("a whole article, as validated and stored", () => {
    const parsed = parseDoc(
      "article",
      doc(heading(2, "Who can invite"), p(text("Owners and "), text("admins", bold), text(".")), {
        type: "bulletList",
        content: [item(p(text("Team page")))],
      }),
    );
    expect(parsed.ok && toMarkdown(parsed.doc)).toBe("## Who can invite\n\nOwners and **admins**.\n\n- Team page");
  });
});
