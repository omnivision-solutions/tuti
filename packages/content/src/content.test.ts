import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { docHeadings, fromPlainText, imageKeysIn, isEmptyDoc, MAX_CHUNK_LENGTH, mediaIdsIn, parseDoc, toChunks, toPlainText, updateImages } from "./document";
import { isSafeLink, parseVideoUrl, videoEmbedUrl } from "./links";
import { RichText } from "./react";

const doc = (...content: object[]) => ({ type: "doc", content });
const p = (...content: object[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks && { marks }) });
const link = (href: string) => ({ type: "link", attrs: { href } });
const video = (provider: string, id: string) => ({ type: "video", attrs: { provider, id } });
const MEDIA_ID = "clx0abcdefghijklmnopqrstu";
const image = (attrs: object = {}) => ({
  type: "image",
  attrs: { mediaId: MEDIA_ID, width: "50", align: "right", alt: "A chart", w: 1200, h: 800, ...attrs },
});
const cell = (type: string, value: string, attrs: object = {}) => ({
  type,
  attrs: { colspan: 1, rowspan: 1, ...attrs },
  content: [p(text(value))],
});
const table = (...rows: object[][]) => ({ type: "table", content: rows.map((content) => ({ type: "tableRow", content })) });
const list = (...items: string[]) => ({
  type: "bulletList",
  content: items.map((item) => ({ type: "listItem", content: [p(text(item))] })),
});

describe("links", () => {
  test.each([
    ["https://example.com/a?b=c", true],
    ["http://example.com", true],
    ["mailto:hi@example.com", true],
    ["javascript:alert(1)", false],
    ["JavaScript:alert(1)", false],
    [" javascript:alert(1)", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["vbscript:msgbox(1)", false],
    ["//evil.example", false],
    ["/relative", false],
    ["example.com", false],
    [`https://example.com/${"a".repeat(2048)}`, false],
  ])("%s safe: %s", (href, safe) => {
    expect(isSafeLink(href)).toBe(safe);
  });

  test.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://youtu.be/dQw4w9WgXcQ", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://vimeo.com/76979871", { provider: "vimeo", id: "76979871" }],
    ["https://player.vimeo.com/video/76979871", { provider: "vimeo", id: "76979871" }],
    [
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=x",
      { provider: "loom", id: "0123456789abcdef0123456789abcdef" },
    ],
    ["https://www.youtube.com/watch?v=short", null],
    ["https://evil.example/watch?v=dQw4w9WgXcQ", null],
    ["https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
  ])("video %s", (url, expected) => {
    expect(parseVideoUrl(url)).toEqual(expected);
  });
});

describe("parseDoc", () => {
  test("accepts what the profile allows and returns it normalised", () => {
    const result = parseDoc(
      "post",
      doc(p(text("Dark mode", [{ type: "bold" }]), text(" see "), text("here", [link("https://example.com")])), list("a", "b"), video("youtube", "dQw4w9WgXcQ")),
    );
    expect(result).toEqual({ ok: true, doc: expect.objectContaining({ type: "doc" }) });
    expect(result.ok && toPlainText(result.doc)).toBe("Dark mode see here\na\nb\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  test("changelog entries also have headings, quotes and dividers", () => {
    const entry = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("New")] },
      { type: "blockquote", content: [p(text("Finally!"))] },
      { type: "horizontalRule" },
      p(text("More")),
    );
    expect(parseDoc("changelog", entry)).toMatchObject({ ok: true });
    expect(parseDoc("post", entry)).toMatchObject({ ok: false });
  });

  test("articles also have tables; changelog entries don't", () => {
    const article = doc(table([cell("tableHeader", "Plan"), cell("tableHeader", "Seats")], [cell("tableCell", "Pro"), cell("tableCell", "10")]));
    expect(parseDoc("article", article)).toMatchObject({ ok: true });
    expect(parseDoc("changelog", article)).toMatchObject({ ok: false });
    expect(parseDoc("article", doc(table([cell("tableCell", "x", { colspan: 1000 })])))).toEqual({
      ok: false,
      error: "This table can't be used here.",
    });
  });

  test("also reads JSON strings, as forms send them", () => {
    expect(parseDoc("comment", JSON.stringify(doc(p(text("Hi")))))).toMatchObject({ ok: true });
  });

  test.each([
    ["a list in a comment", "comment", doc(list("a"))],
    ["a video in a comment", "comment", doc(video("youtube", "dQw4w9WgXcQ"))],
    ["a heading in a post", "post", doc({ type: "heading", attrs: { level: 1 }, content: [text("Big")] })],
    ["an unknown node", "post", doc({ type: "script", content: [text("alert(1)")] })],
    ["an unknown mark", "post", doc(p(text("x", [{ type: "highlight" }])))],
    ["text directly in the doc", "post", doc(text("loose"))],
    ["not a doc", "post", p(text("x"))],
    ["broken JSON", "post", "{"],
    ["nothing", "post", null],
  ] as const)("rejects %s", (_name, profile, input) => {
    expect(parseDoc(profile, input)).toMatchObject({ ok: false });
  });

  test.each([
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["/relative"],
  ])("rejects a %s link", (href) => {
    expect(parseDoc("comment", doc(p(text("x", [link(href)]))))).toEqual({
      ok: false,
      error: "Links must start with http://, https:// or mailto:.",
    });
  });

  test("rejects videos from other providers or with made-up ids", () => {
    for (const bad of [video("evil", "x"), video("youtube", "<script>"), video("loom", "../../x")]) {
      expect(parseDoc("post", doc(bad))).toEqual({ ok: false, error: "Only YouTube, Vimeo and Loom videos can be embedded." });
    }
  });

  test("drops attributes it doesn't know, and reduces links to their href", () => {
    const result = parseDoc(
      "comment",
      doc({ type: "paragraph", attrs: { onclick: "x" }, content: [text("x", [{ type: "link", attrs: { href: "https://example.com", target: "_self", class: "evil", rel: "opener" } }])] }),
    );
    expect(result.ok && result.doc).toEqual(doc(p(text("x", [link("https://example.com")]))));
  });

  test("rejects content that's too big", () => {
    expect(parseDoc("comment", doc(p(text("x".repeat(200_001)))))).toEqual({ ok: false, error: "This is too long." });
  });
});

describe("plain text", () => {
  test("round-trips plain text through a document", () => {
    const original = "First line\nsecond line\n\nNew paragraph";
    const converted = fromPlainText(original);
    expect(parseDoc("comment", converted)).toMatchObject({ ok: true });
    expect(toPlainText(converted)).toBe("First line\nsecond line\nNew paragraph");
  });

  test("empty text is an empty document", () => {
    expect(isEmptyDoc(fromPlainText("  \n\n "))).toBe(true);
    expect(isEmptyDoc(doc(video("vimeo", "76979871")))).toBe(false);
    expect(isEmptyDoc(doc({ type: "image", attrs: { mediaId: "clx0abcdefghijklmnopqrstu", alt: "" } }))).toBe(false);
  });
});

describe("chunks", () => {
  const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });

  test("each heading starts a section with the text up to the next one", () => {
    expect(
      toChunks(
        doc(p(text("Intro")), heading("Who can invite"), p(text("Owners.")), list("Admins", "Editors"), heading("Limits"), heading("Seats"), p(text("Ten."))),
      ),
    ).toEqual([
      { heading: "", text: "Intro" },
      { heading: "Who can invite", text: "Owners.\n\nAdmins\nEditors" },
      { heading: "Limits", text: "" },
      { heading: "Seats", text: "Ten." },
    ]);
  });

  test("long sections are split between blocks, and a block longer than a chunk is cut", () => {
    const third = "a".repeat(MAX_CHUNK_LENGTH / 3);
    const chunks = toChunks(doc(heading("Long"), p(text(third)), p(text(third)), p(text(third)), p(text("b".repeat(MAX_CHUNK_LENGTH + 10)))));
    expect(chunks).toEqual([
      { heading: "Long", text: `${third}\n\n${third}` },
      { heading: "Long", text: third },
      { heading: "Long", text: "b".repeat(MAX_CHUNK_LENGTH) },
      { heading: "Long", text: "b".repeat(10) },
    ]);
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
  });

  test("an empty document is one empty chunk, so its title can still be found", () => {
    expect(toChunks(fromPlainText(""))).toEqual([{ heading: "", text: "" }]);
  });
});

describe("RichText", () => {
  const html = (content: object) => renderToStaticMarkup(createElement(RichText, { doc: content }));

  test("renders text as text, never as markup", () => {
    expect(html(doc(p(text("<img src=x onerror=alert(1)>"))))).toBe("<div><p>&lt;img src=x onerror=alert(1)&gt;</p></div>");
  });

  test("headings sit under the page's title (h2, h3), with quotes and dividers", () => {
    const out = html(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [text("A")] },
        { type: "heading", attrs: { level: 3 }, content: [text("B")] },
        { type: "blockquote", content: [p(text("C"))] },
        { type: "horizontalRule" },
      ),
    );
    expect(out).toBe("<div><h2>A</h2><h3>B</h3><blockquote><p>C</p></blockquote><hr/></div>");
  });

  test("links get safe attributes; unsafe links render as plain text", () => {
    expect(html(doc(p(text("ok", [link("https://example.com")]))))).toContain(
      '<a href="https://example.com" rel="noopener noreferrer nofollow ugc" target="_blank">ok</a>',
    );
    expect(html(doc(p(text("bad", [link("javascript:alert(1)")]))))).toBe("<div><p>bad</p></div>");
  });

  test("videos embed from the provider's known URL in a sandboxed frame", () => {
    const out = html(doc(video("youtube", "dQw4w9WgXcQ")));
    expect(out).toContain(`src="${videoEmbedUrl({ provider: "youtube", id: "dQw4w9WgXcQ" })}"`);
    expect(out).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
    expect(html(doc(video("youtube", '"><script>')))).toBe("<div></div>");
  });

  test("tables render as tables, with only sane spans", () => {
    expect(html(doc(table([cell("tableHeader", "A", { colspan: 2 })], [cell("tableCell", "B", { rowspan: "9" }), cell("tableCell", "C")])))).toBe(
      '<div><div class="rich-table"><table><tbody><tr><th colSpan="2"><p>A</p></th></tr><tr><td><p>B</p></td><td><p>C</p></td></tr></tbody></table></div></div>',
    );
  });

  test("skips nodes it doesn't know", () => {
    expect(html(doc({ type: "script", content: [text("alert(1)")] }, p(text("ok"))))).toBe("<div><p>ok</p></div>");
  });
});

describe("images", () => {
  test("posts may have uploaded images, sized and aligned; comments may not", () => {
    const result = parseDoc("post", doc(image()));
    expect(result.ok && result.doc.content?.[0]).toEqual(image());
    expect(parseDoc("comment", doc(image()))).toMatchObject({ ok: false });
  });

  test.each([
    ["an unknown width", { width: "33" }],
    ["an unknown alignment", { align: "justify" }],
    ["a made-up media id", { mediaId: "../../etc/passwd" }],
    ["alt text that's too long", { alt: "x".repeat(301) }],
  ])("refuses %s", (_name, attrs) => {
    expect(parseDoc("post", doc(image(attrs)))).toEqual({ ok: false, error: "This image can't be used here." });
  });

  test("finds and updates the images in a document", () => {
    const content = { type: "doc", content: [image(), p(text("x")), image()] };
    expect(mediaIdsIn(content)).toEqual([MEDIA_ID]);
    updateImages(content, () => ({ w: 300, h: 200 }));
    expect(content.content[0]).toMatchObject({ attrs: { w: 300, h: 200 } });
    expect(imageKeysIn(content)).toEqual([`m/${MEDIA_ID}/300.webp`, `m/${MEDIA_ID}/email.jpg`]);
    expect(toPlainText(content)).toBe("A chart\nx\nA chart");
  });

  /** What the server's signing gives: a URL for each stored file. */
  const signed = (d: object) => Object.fromEntries(imageKeysIn(d).map((key) => [key, `https://storage.example/${key}?sig=1`]));

  test("renders a responsive image from its signed URLs, at its share of the column", () => {
    const out = renderToStaticMarkup(createElement(RichText, { doc: doc(image()), mediaUrls: signed(doc(image())) }));
    expect(out).toContain('<figure class="rich-image" data-width="50" data-align="right">');
    expect(out).toContain(`src="https://storage.example/m/${MEDIA_ID}/960.webp?sig=1"`);
    expect(out).toContain(
      `srcSet="https://storage.example/m/${MEDIA_ID}/480.webp?sig=1 480w, https://storage.example/m/${MEDIA_ID}/960.webp?sig=1 960w, https://storage.example/m/${MEDIA_ID}/1200.webp?sig=1 1200w"`,
    );
    expect(out).toContain('sizes="(max-width: 768px) 100vw, 384px"');
    expect(out).toContain('width="1200" height="800" alt="A chart" loading="lazy"');
  });

  test("without signed URLs, or without a real size, images are left out", () => {
    expect(renderToStaticMarkup(createElement(RichText, { doc: doc(image()) }))).toBe("<div></div>");
    expect(renderToStaticMarkup(createElement(RichText, { doc: doc(image()), mediaUrls: signed(doc(image({ mediaId: "c".repeat(25) }))) }))).toBe(
      "<div></div>",
    );
    for (const size of [{ w: null }, { h: 0 }, { w: -1200 }, { h: 1.5 }]) {
      expect(renderToStaticMarkup(createElement(RichText, { doc: doc(image(size)), mediaUrls: signed(doc(image())) }))).toBe("<div></div>");
    }
  });
});

describe("headings", () => {
  const h = (level: number, ...content: object[]) => ({ type: "heading", attrs: { level }, content });
  const article = doc(
    h(2, text("Getting started")),
    p(text("Hi")),
    h(3, text("What's "), text("new?", [{ type: "bold" }])),
    h(2, text("Getting started")),
    h(2, text("Getting started")),
    h(2, text("Café & Crème")),
    h(2, text("お支払い")),
    h(3, text("Section 8")),
    h(2, text("Цены")),
    { type: "blockquote", content: [h(2, text("Quoted"))] },
  );

  test("an article's top-level h2 and h3, with ids from their text: repeats numbered, non-Latin text as section-N", () => {
    expect(docHeadings(article)).toEqual([
      { id: "getting-started", text: "Getting started", level: 2 },
      { id: "what-s-new", text: "What's new?", level: 3 },
      { id: "getting-started-2", text: "Getting started", level: 2 },
      { id: "getting-started-3", text: "Getting started", level: 2 },
      { id: "cafe-creme", text: "Café & Crème", level: 2 },
      { id: "section-6", text: "お支払い", level: 2 },
      // A heading's text can make a fallback's id too: the later one is numbered.
      { id: "section-8", text: "Section 8", level: 3 },
      { id: "section-8-2", text: "Цены", level: 2 },
    ]);
    expect(docHeadings(doc(p(text("No headings"))))).toEqual([]);
  });

  test("a heading never takes the id of the page's title", () => {
    expect(docHeadings(doc(h(2, text("Article title")), h(3, text("Article title"))))).toEqual([
      { id: "article-title-2", text: "Article title", level: 2 },
      { id: "article-title-3", text: "Article title", level: 3 },
    ]);
  });

  test("RichText gives headings those ids only when asked (articles)", () => {
    const ids = (out: string) => [...out.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
    const out = renderToStaticMarkup(createElement(RichText, { doc: article, headingIds: true }));
    expect(ids(out)).toEqual(docHeadings(article).map((heading) => heading.id));
    expect(out).toContain('<h3 id="what-s-new">What&#x27;s <strong>new?</strong></h3>');
    expect(out).toContain("<blockquote><h2>Quoted</h2></blockquote>");
    expect(ids(renderToStaticMarkup(createElement(RichText, { doc: article })))).toEqual([]);
  });
});
