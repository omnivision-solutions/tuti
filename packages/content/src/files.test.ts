import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { filesIn, isEmptyDoc, mediaIdsIn, parseDoc, toChunks, toPlainText, updateFiles } from "./document";
import { toMarkdown } from "./markdown";
import { fileExtension, fileKey, fileSize, mediaKeys } from "./media";
import { RichText } from "./react";

const MEDIA_ID = "clx0abcdefghijklmnopqrstu";
const doc = (...content: object[]) => ({ type: "doc", content });
const file = (attrs: object = {}) => ({ type: "file", attrs: { mediaId: MEDIA_ID, name: "Price list [2026].pdf", size: 1_572_864, ...attrs } });
const signed = { [fileKey(MEDIA_ID)]: "https://storage.example/m/file?sig=1" };

describe("file attachments", () => {
  test("only articles have them", () => {
    const result = parseDoc("article", doc(file()));
    expect(result.ok && result.doc.content?.[0]).toEqual(file());
    for (const profile of ["comment", "post", "changelog"] as const) {
      expect(parseDoc(profile, doc(file()))).toMatchObject({ ok: false });
    }
  });

  test.each([
    ["no upload", { mediaId: "../etc/passwd" }],
    ["a name that isn't text", { name: 42 }],
    ["a name that's too long", { name: `${"a".repeat(200)}.pdf` }],
    ["a size that isn't a whole number of bytes", { size: -1 }],
  ])("rejects %s", (_, attrs) => {
    expect(parseDoc("article", doc(file(attrs)))).toEqual({ ok: false, error: "This file can't be used here." });
  });

  test("drops attributes it doesn't know", () => {
    const result = parseDoc("article", doc(file({ href: "javascript:alert(1)" })));
    expect(result.ok && result.doc.content?.[0]).toEqual(file());
  });

  test("are uploads to attach and keep, with their download name, and take their name and size from the upload", () => {
    const content = doc(file(), { type: "paragraph" });
    expect(mediaIdsIn(content)).toEqual([MEDIA_ID]);
    expect(filesIn(content)).toEqual([{ key: `m/${MEDIA_ID}/file`, name: "Price list [2026].pdf" }]);
    expect(mediaKeys({ id: MEDIA_ID, width: null })).toContain(fileKey(MEDIA_ID));
    updateFiles(content, () => ({ name: "prices.pdf", size: 10 }));
    expect(content.content[0]).toEqual(file({ name: "prices.pdf", size: 10 }));
  });

  test("their plain text is the file's name, so search and answers find it; a document with one isn't empty", () => {
    expect(toPlainText(doc(file()))).toBe("Price list [2026].pdf");
    expect(toChunks(doc(file()))).toEqual([{ heading: "", text: "Price list [2026].pdf" }]);
    expect(isEmptyDoc(doc(file({ name: "" })))).toBe(false);
  });

  test("Markdown links the file, its name escaped; without a link, the name alone", () => {
    expect(toMarkdown(doc(file()), { mediaUrls: signed })).toBe("[Price list \\[2026\\].pdf](https://storage.example/m/file?sig=1)");
    expect(toMarkdown(doc(file()))).toBe("Price list \\[2026\\].pdf");
  });

  test("render as a download with the type, name and size; without a signed link they're left out", () => {
    const html = renderToStaticMarkup(createElement(RichText, { doc: doc(file({ name: "<b>notes</b>.pdf" })), mediaUrls: signed }));
    expect(html).toBe(
      '<div><a class="rich-file" href="https://storage.example/m/file?sig=1" download="&lt;b&gt;notes&lt;/b&gt;.pdf">' +
        '<span class="rich-file-type" aria-hidden="true">PDF</span><span class="rich-file-name">&lt;b&gt;notes&lt;/b&gt;.pdf</span>' +
        '<span class="rich-file-size">1.5 MB</span></a></div>',
    );
    expect(renderToStaticMarkup(createElement(RichText, { doc: doc(file()) }))).toBe("<div></div>");
  });

  test("extensions and sizes as people read them", () => {
    expect(fileExtension("Report.final.PDF")).toBe("pdf");
    expect(fileExtension("README")).toBe("");
    expect(fileSize(300)).toBe("1 KB");
    expect(fileSize(1_572_864)).toBe("1.5 MB");
  });
});
