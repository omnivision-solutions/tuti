import { expect, test } from "vitest";

import { htmlAsText, MARKED_LEVELS, MAX_DEPTH, MAX_HTML } from "./email-text";

/** What nests in a way the library goes over again at each level. */
const NESTING = ["<blockquote>Earlier", "<ul><li>Earlier", "<ol><li>Earlier", '<a href="https://acme.example/">Earlier', "<h1>Earlier"];

const indent = (text: string) => Math.max(...text.split("\n").map((line) => line.length - line.trimStart().length));

test("quotes are marked as deep as they go, up to five, and not again below that", () => {
  const html = `<p>Thanks</p>${Array.from({ length: MARKED_LEVELS + 2 }, (_, i) => `<blockquote>Level ${i + 1}`).join("")}`;
  const text = htmlAsText(html);
  expect(text).toContain("\n> Level 1");
  expect(text).toContain("\n> > Level 2");
  expect(text).toContain(`\n${"> ".repeat(MARKED_LEVELS)}Level ${MARKED_LEVELS + 2}`);
  expect(text).not.toContain("> ".repeat(MARKED_LEVELS + 1));
});

test("lists are indented as deep as they go, up to five, and not again below that", () => {
  const text = htmlAsText(`<ul><li>Level 1${Array.from({ length: MARKED_LEVELS + 1 }, (_, i) => `<ul><li>Level ${i + 2}`).join("")}`);
  expect(text).toMatch(/^ \* Level 1\n +\* Level 2\n/);
  expect(text).toContain(`Level ${MARKED_LEVELS + 2}`);
  expect(indent(text)).toBeLessThanOrEqual(MARKED_LEVELS * 3);
  // A plain list as ever.
  expect(htmlAsText("<ol><li>One</li><li>Two</li></ol>")).toBe(" 1. One\n 2. Two");
});

test("only so much HTML is read, and only so deep (its time: email-text.live.test.ts)", () => {
  expect(htmlAsText(`<p>Start</p>${"x".repeat(MAX_HTML)}<p>End</p>`)).not.toContain("End");
  expect(htmlAsText(`<p>Start</p>${"<div>".repeat(MAX_DEPTH + 10)}Deep`)).not.toContain("Deep");
  // Deep quotes or lists over many lines: the text grows with the HTML, not with how deep it nests.
  for (const open of NESTING) {
    const html = `${open.repeat(195)}${"x<br>".repeat(50_000)}`;
    expect(htmlAsText(html).length, open).toBeLessThan(html.length * 4);
  }
});

test("links and headings within links and headings take their form five levels deep, and not below that", () => {
  // A link opened inside another isn't closed by it: each gives its address after its words, five at most.
  const links = htmlAsText(`<p>See ${'<a href="https://acme.example/docs">the docs'.repeat(MARKED_LEVELS + 5)}</p>`);
  expect(links).toMatch(/^See the docs/);
  expect(links.split("[https://acme.example/docs]")).toHaveLength(MARKED_LEVELS + 1);
  // A plain link and heading as ever.
  expect(htmlAsText('<h2>Export</h2><p>See <a href="https://acme.example/docs">the docs</a>.</p>')).toBe("EXPORT\n\nSee the docs [https://acme.example/docs].");
  expect(htmlAsText(`${"<h1>Title ".repeat(MARKED_LEVELS + 5)}`)).toMatch(/^TITLE/);
});
