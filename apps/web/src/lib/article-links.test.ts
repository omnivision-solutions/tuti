import { expect, test } from "vitest";

import { articleDescription, docLinks, portalDocsLink } from "./article-links";

const addresses = ["https://acme.tuti.example", "https://acme.example/help"];

test("a link to one of the portal's docs pages, at any of its addresses, with its heading", () => {
  expect(portalDocsLink("https://acme.tuti.example/docs/getting-started", addresses)).toEqual({ slug: "getting-started", hash: "" });
  expect(portalDocsLink("https://acme.example/help/docs/billing#refunds", addresses)).toEqual({ slug: "billing", hash: "#refunds" });
  expect(portalDocsLink("http://acme.tuti.example/docs/x", addresses)).toBeNull();
});

test("anything else is the usual link: another site, another of its pages, under another path, a query or the Markdown", () => {
  for (const href of [
    "https://other.example/docs/getting-started",
    "https://acme.example/docs/getting-started",
    "https://acme.tuti.example/feedback/ideas",
    "https://acme.tuti.example/docs",
    "https://acme.tuti.example/docs/a/b",
    "https://acme.tuti.example/docs/getting-started?ref=1",
    "https://acme.tuti.example/docs/getting-started.md",
    "mailto:help@acme.example",
    "not a url",
  ]) {
    expect(portalDocsLink(href, addresses), href).toBeNull();
  }
});

test("a document's links, once each, from its text at any depth", () => {
  const link = (href: string) => ({ type: "text", text: "x", marks: [{ type: "bold" }, { type: "link", attrs: { href } }] });
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [link("https://a.example"), { type: "text", text: "plain" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [link("https://b.example"), link("https://a.example")] }] }] },
    ],
  };
  expect(docLinks(doc)).toEqual(["https://a.example", "https://b.example"]);
});

test("what an article is about: the team's description, else its text's first lines", () => {
  expect(articleDescription({ description: "Set it up.", body: "Long text" })).toBe("Set it up.");
  expect(articleDescription({ description: "", body: "Install\n\nthe   app." })).toBe("Install the app.");
  expect(articleDescription({ description: "", body: "word ".repeat(60) })).toMatch(/^(word ){30}.*…$/);
});
