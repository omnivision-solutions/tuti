import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { type Doc, parseDoc } from "./document";
import { fileName, htmlText, htmlToContent, type HtmlOptions, type MediaSource } from "./html";
import type { Profile } from "./profiles";

/** Invented media ids, one per source key, as an importer would make them. */
function fakeMedia() {
  const copied: MediaSource[] = [];
  const media: HtmlOptions["media"] = async (source) => {
    copied.push(source);
    const mediaId = `media${String(copied.length).padStart(20, "0")}`;
    return { mediaId, width: 800, height: 600, filename: source.name ?? null, size: 1234 };
  };
  return { media, copied };
}

async function convert(profile: Profile, html: string, options: HtmlOptions = {}) {
  const result = await htmlToContent(profile, html, options);
  if ("error" in result) {
    throw new Error(result.error);
  }
  // What's returned is what parseDoc keeps.
  expect(parseDoc(profile, result.doc)).toEqual({ ok: true, doc: result.doc });
  return result;
}

const blocks = async (profile: Profile, html: string, options?: HtmlOptions) => (await convert(profile, html, options)).doc.content;
const text = (t: string, marks?: Doc["marks"]) => ({ type: "text", text: t, ...(marks && { marks }) });
const p = (...content: object[]) => ({ type: "paragraph", ...(content.length > 0 && { content }) });
const bold = (t: string) => p(text(t, [{ type: "bold" }]));
const heading = (level: number, t: string) => ({ type: "heading", attrs: { level }, content: [text(t)] });

describe("headings", () => {
  test("articles get h2 and h3: with an h1, every level moves down one", async () => {
    expect(await blocks("article", "<h1>Setup</h1><h2>Install</h2><h3>On Linux</h3><h4>Debian</h4>")).toEqual([
      heading(2, "Setup"),
      heading(3, "Install"),
      heading(3, "On Linux"),
      heading(3, "Debian"),
    ]);
    expect(await blocks("changelog", "<h2>New</h2><h3>Fixed</h3><h5>Small</h5>")).toEqual([heading(2, "New"), heading(3, "Fixed"), heading(3, "Small")]);
  });

  test("posts and comments have no headings: bold lines", async () => {
    expect(await blocks("post", "<h2>Why</h2><p>Because.</p>")).toEqual([bold("Why"), p(text("Because."))]);
    expect(await blocks("comment", "<h1>Why</h1>")).toEqual([bold("Why")]);
  });
});

test("lists, code, quotes and tables keep their shape where the profile has them", async () => {
  const html =
    "<ul><li><p>One</p></li></ul><ol start=\"3\"><li>Three</li></ol><pre><code class=\"language-bash\">npm i\nnpm test</code></pre>" +
    "<blockquote><p>Quoted</p></blockquote><table style=\"minWidth: 50px\"><colgroup><col></colgroup><tbody><tr><th>Plan</th><td colspan=\"40\" rowspan=\"1\"><p>Free</p></td></tr></tbody></table>";
  const listItem = (t: string) => ({ type: "listItem", content: [p(text(t))] });
  expect(await blocks("article", html)).toEqual([
    { type: "bulletList", content: [listItem("One")] },
    { type: "orderedList", attrs: { start: 3, type: null }, content: [listItem("Three")] },
    { type: "codeBlock", attrs: { language: "bash", filename: null }, content: [text("npm i\nnpm test")] },
    { type: "blockquote", content: [p(text("Quoted"))] },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(text("Plan"))] },
            // Spans are kept within what Tuti takes.
            { type: "tableCell", attrs: { colspan: 20, rowspan: 1, colwidth: null }, content: [p(text("Free"))] },
          ],
        },
      ],
    },
  ]);
  // A comment has only paragraphs: the words stay.
  expect((await convert("comment", html)).text).toBe("One\nThree\nnpm i\nnpm test\nQuoted\nPlan\nFree");
});

describe("Featurebase's blocks", () => {
  test("a callout is a quote", async () => {
    expect(await blocks("article", '<callout-component color="Red"><p>Back up first.</p></callout-component>')).toEqual([
      { type: "blockquote", content: [p(text("Back up first."))] },
    ]);
  });

  test("an accordion is collapsible details (articles), without headings or accordions inside; elsewhere a bold line and its body", async () => {
    const html = '<details class="details"><summary>Billing</summary><div><h3>Cards</h3><p>Any card.</p><details><summary>Inner</summary><div><p>Deep</p></div></details></div></details>';
    expect(await blocks("article", html)).toEqual([
      {
        type: "details",
        content: [
          { type: "detailsSummary", content: [text("Billing")] },
          { type: "detailsContent", content: [bold("Cards"), p(text("Any card.")), bold("Inner"), p(text("Deep"))] },
        ],
      },
    ]);
    expect(await blocks("post", html)).toEqual([bold("Billing"), bold("Cards"), p(text("Any card.")), bold("Inner"), p(text("Deep"))]);
    // No summary: just its body.
    expect(await blocks("article", "<details><summary> </summary><div><p>Body</p></div></details>")).toEqual([p(text("Body"))]);
  });

  test("columns are their content in order", async () => {
    const html =
      '<div data-type="columns" class="layout-two-column"><div data-type="column" data-position="left"><p>Left</p></div><div data-type="column" data-position="right"><p>Right</p></div></div>';
    expect(await blocks("article", html)).toEqual([p(text("Left")), p(text("Right"))]);
  });

  test("multi-language code is code tabs in articles, labelled; elsewhere code blocks", async () => {
    const data = JSON.stringify([
      { id: "a", name: "npm", value: "npm i tuti", language: "bash" },
      { id: "b", name: "", value: "yarn add tuti", language: "bash" },
    ]);
    const html = `<multicode-component data='${data}' activecode="a"></multicode-component>`;
    const block = (filename: string | null, code: string) => ({ type: "codeBlock", attrs: { language: "bash", ...(filename !== undefined && { filename }) }, content: [text(code)] });
    expect(await blocks("article", html)).toEqual([{ type: "codeTabs", content: [block("npm", "npm i tuti"), block("Tab 2", "yarn add tuti")] }]);
    expect(await blocks("post", html)).toEqual([
      { type: "codeBlock", attrs: { language: "bash" }, content: [text("npm i tuti")] },
      { type: "codeBlock", attrs: { language: "bash" }, content: [text("yarn add tuti")] },
    ]);
  });

  test("YouTube, Vimeo and Loom iframes are video embeds; other iframes, and videos in comments, are links", async () => {
    const html = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe><iframe src="https://example.com/embed/1"></iframe>';
    const link = (href: string) => p(text(href, [{ type: "link", attrs: { href } }]));
    expect(await blocks("post", html)).toEqual([{ type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } }, link("https://example.com/embed/1")]);
    expect(await blocks("comment", html)).toEqual([link("https://www.youtube.com/embed/dQw4w9WgXcQ"), link("https://example.com/embed/1")]);
  });

  test("an uploaded video is left out and counted", async () => {
    const result = await convert("article", '<p>Watch</p><video src="https://files.example.com/demo.mp4"></video>');
    expect(result.doc.content).toEqual([p(text("Watch"))]);
    expect(result.leftOut).toEqual([{ kind: "video", url: "https://files.example.com/demo.mp4", reason: "unsupported" }]);
  });

  test("task lists are lists", async () => {
    expect(await blocks("post", '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li></ul>')).toEqual([
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("Done"))] }] },
    ]);
  });
});

describe("links", () => {
  test("each goes through the rewriter; unsafe ones keep only their text", async () => {
    const seen: string[] = [];
    const link = (href: string) => {
      seen.push(href);
      return href.includes("/articles/") ? "https://acme.example.com/docs/billing" : null;
    };
    const html =
      '<p><a class="link" href="https://help.example.com/en/articles/0123456-billing">Billing</a> and <a href="https://example.com" target="_blank">site</a>' +
      ' and <a href="javascript:alert(1)">bad</a> and <a href="/en/collections/0123457-start">relative</a></p>';
    const linked = (t: string, href: string) => text(t, [{ type: "link", attrs: { href } }]);
    expect(await blocks("comment", html, { link })).toEqual([
      p(linked("Billing", "https://acme.example.com/docs/billing"), text(" and "), linked("site", "https://example.com"), text(" and bad and relative")),
    ]);
    expect(seen).toEqual([
      "https://help.example.com/en/articles/0123456-billing",
      "https://example.com",
      "javascript:alert(1)",
      "/en/collections/0123457-start",
    ]);
  });
});

describe("images and files", () => {
  test("an image is copied once per key, sized from the copy, its width and alignment kept", async () => {
    const { media, copied } = fakeMedia();
    const src = "https://org.featurebase-attachments.com/c/article/1/2/b64u-c2NyZWVuLnBuZw.png?X-Amz-Signature=abc";
    const result = await convert(
      "article",
      `<p>See:<img src="${src}" alt="The screen" data-width="50%" data-align="left" data-featurebase-content-key="org/article/1/2/b64u-c2NyZWVuLnBuZw.png"></p>`,
      { media },
    );
    // The key is the URL without its signature (new every time it's read).
    expect(copied).toEqual([{ kind: "image", url: src, key: "https://org.featurebase-attachments.com/c/article/1/2/b64u-c2NyZWVuLnBuZw.png" }]);
    expect(result.doc.content).toEqual([
      p(text("See:")),
      { type: "image", attrs: { mediaId: "media00000000000000000001", width: "50", align: "left", alt: "The screen", w: 800, h: 600 } },
    ]);
    expect(result.mediaIds).toEqual(["media00000000000000000001"]);
    // A linked image is the image.
    expect(await blocks("post", '<p><a href="https://example.com"><img src="https://cdn.example.com/a.png"></a></p>', { media })).toEqual([
      { type: "image", attrs: { mediaId: "media00000000000000000002", width: "100", align: "center", alt: "", w: 800, h: 600 } },
    ]);
  });

  test("the key comes from the URL alone, never from an attribute the HTML's writer chose", async () => {
    const { media, copied } = fakeMedia();
    const forged = 'data-featurebase-content-key="org/article/1/2/b64u-c2NyZWVuLnBuZw.png"';
    await convert("post", `<img src="https://cdn.example.com/mine.png" ${forged}><img src="https://cdn.example.com/theirs.png?v=2" ${forged}>`, { media });
    expect(copied.map((source) => source.key)).toEqual(["https://cdn.example.com/mine.png", "https://cdn.example.com/theirs.png?v=2"]);
  });

  test("comments take no images: left out and counted, their alt text kept", async () => {
    const { media, copied } = fakeMedia();
    const result = await convert("comment", '<p>Here</p><img src="https://cdn.example.com/a.png" alt="A chart"><img src="https://cdn.example.com/b.png">', { media });
    expect(copied).toEqual([]);
    expect(result.doc.content).toEqual([p(text("Here")), p(text("A chart"))]);
    expect(result.leftOut).toEqual([
      { kind: "image", url: "https://cdn.example.com/a.png", reason: "unsupported" },
      { kind: "image", url: "https://cdn.example.com/b.png", reason: "unsupported" },
    ]);
  });

  test("one that couldn't be copied is left out with the importer's reason", async () => {
    const result = await convert("post", '<img src="https://cdn.example.com/a.png" alt="Big">', { media: async () => ({ leftOut: "size" }) });
    expect(result.doc.content).toEqual([p(text("Big"))]);
    expect(result.leftOut).toEqual([{ kind: "image", url: "https://cdn.example.com/a.png", reason: "size" }]);
  });

  test("in articles, attached documents are files (file blocks, and links to the attachment host); elsewhere links stay and file blocks are left out", async () => {
    const pdf = "https://org.featurebase-attachments.com/c/article/1/2/b64u-UHJpY2luZy5wZGY.pdf?X-Amz-Signature=abc";
    const html =
      `<file-preview-component src="https://org.featurebase-attachments.com/x/guide.pdf" data-featurebase-content-filename="Guide.pdf" data-featurebase-content-filetype="application/pdf"></file-preview-component>` +
      `<p><a href="${pdf}">Pricing</a></p>` +
      `<file-preview-component src="https://org.featurebase-attachments.com/x/shot.png" data-featurebase-content-filetype="image/png"></file-preview-component>`;
    const { media, copied } = fakeMedia();
    const article = await convert("article", html, { media });
    expect(copied.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "file", name: "Guide.pdf" },
      { kind: "file", name: "Pricing.pdf" },
      { kind: "image", name: undefined },
    ]);
    expect(article.doc.content?.map((node) => node.type)).toEqual(["file", "file", "image"]);
    expect(article.doc.content?.[0]?.attrs).toEqual({ mediaId: "media00000000000000000001", name: "Guide.pdf", size: 1234 });

    const post = await convert("post", html, { media: fakeMedia().media });
    expect(post.doc.content?.map((node) => node.type)).toEqual(["paragraph", "paragraph", "image"]);
    expect(post.text).toBe("Guide.pdf\nPricing");
    // A link into the attachment storage expires within the hour: left out (listed), its words kept.
    expect(post.leftOut).toEqual([
      { kind: "file", url: pdf, reason: "unsupported" },
      { kind: "file", url: "https://org.featurebase-attachments.com/x/guide.pdf", reason: "unsupported" },
    ]);
    const image = "https://org.featurebase-attachments.com/c/p/1/b64u-c2hvdA.png?X-Amz-Signature=abc";
    const linked = await convert("comment", `<p>See <a href="${image}">the screenshot</a></p>`);
    expect(linked.text).toBe("See the screenshot");
    expect(linked.leftOut).toEqual([{ kind: "image", url: image, reason: "unsupported" }]);

    // A stored image linked to itself (its full size): copied once in a post, listed once in a comment.
    const wrapped = `<p><a href="${image}"><img src="${image}" alt="shot"></a></p>`;
    const { media: wrappedMedia, copied: wrappedCopies } = fakeMedia();
    const inPost = await convert("post", wrapped, { media: wrappedMedia });
    expect(wrappedCopies).toHaveLength(1);
    expect(inPost.leftOut).toEqual([]);
    expect((await convert("comment", wrapped)).leftOut).toEqual([{ kind: "image", url: image, reason: "unsupported" }]);
    // In an article, a thumbnail linking to a stored document: both come in, and a text link's own words stay.
    const thumbnailMedia = fakeMedia();
    const thumbnailArticle = await convert(
      "article",
      `<p><a href="https://org.featurebase-attachments.com/c/p/1/b64u-UHJpY2luZy5wZGY.pdf?X-Amz-Signature=x"><img src="${image}" alt="shot"></a></p>` +
        `<p>See <a href="https://org.featurebase-attachments.com/c/p/1/b64u-UHJpY2luZy5wZGY.pdf?X-Amz-Signature=y">our pricing sheet</a> for details</p>`,
      { media: thumbnailMedia.media },
    );
    expect(thumbnailMedia.copied.map(({ kind }) => kind)).toEqual(["image", "file", "file"]);
    expect(thumbnailArticle.leftOut).toEqual([]);
    expect(thumbnailArticle.text).toBe("shot\nPricing.pdf\nSee our pricing sheet\nPricing.pdf\n for details");
    // A document's own preview, linked to it, comes in once; a link whose words are its (signed) address is only the file.
    const pdf2 = "https://org.featurebase-attachments.com/c/p/1/b64u-UHJpY2luZy5wZGY.pdf";
    const self = fakeMedia();
    const selfLinked = await convert(
      "article",
      `<a href="${pdf2}?X-Amz-Signature=a"><file-preview-component src="${pdf2}?X-Amz-Signature=b" data-featurebase-content-filetype="application/pdf"></file-preview-component></a>` +
        `<p><a href="${pdf2}?X-Amz-Signature=c">${pdf2}?X-Amz-Signature=c</a></p>`,
      { media: self.media },
    );
    expect(self.copied.map(({ kind }) => kind)).toEqual(["file", "file"]);
    expect(selfLinked.doc.content?.map((node) => node.type)).toEqual(["file", "file"]);
    expect(selfLinked.text).not.toContain("X-Amz-Signature");
    // Outside articles too, a pasted signed address isn't kept as text: the file's name stands in.
    const pasted = await convert("comment", `<p>Here: <a href="${pdf2}?X-Amz-Signature=d">${pdf2}?X-Amz-Signature=d</a></p>`);
    expect(pasted.text).toBe("Here: Pricing.pdf");
    expect(pasted.leftOut).toEqual([{ kind: "file", url: `${pdf2}?X-Amz-Signature=d`, reason: "unsupported" }]);
    // A thumbnail linking to another stored file: that file is listed too.
    const thumbnail = `<p><a href="https://org.featurebase-attachments.com/c/p/1/b64u-UHJpY2luZw.pdf?X-Amz-Signature=x"><img src="${image}" alt="shot"></a></p>`;
    expect((await convert("post", thumbnail, { media: fakeMedia().media })).leftOut).toEqual([
      { kind: "file", url: "https://org.featurebase-attachments.com/c/p/1/b64u-UHJpY2luZw.pdf?X-Amz-Signature=x", reason: "unsupported" },
    ]);
  });

  test("a file's name comes from Featurebase's storage key", () => {
    expect(fileName("https://org.featurebase-attachments.com/c/a/b/b64u-UHJpY2luZy5wZGY.pdf?x=1")).toBe("Pricing.pdf");
    expect(fileName("https://cdn.example.com/files/Report%202026.pdf")).toBe("Report 2026.pdf");
  });
});

test("scripts, styles, event handlers and Tuti's own attributes are dropped", async () => {
  const { media, copied } = fakeMedia();
  const html =
    '<script>alert(1)</script><style>p { color: red }</style><p onclick="alert(1)" style="color:red" class="x">Hi <img src="x" onerror="alert(1)" alt=""></p>' +
    '<figure data-image data-media-id="cotherprojectsmedia000001"><img alt="Not ours"></figure><div data-video data-provider="youtube" data-id="dQw4w9WgXcQ"></div>' +
    '<div data-file data-media-id="cotherprojectsmedia000002" data-name="x.pdf"></div><ol data-steps><li data-step><p data-step-title>Step</p></li></ol>';
  const result = await convert("article", html, { media });
  // Only images it copied (the bare img's src, which the importer refuses in real life), never an id from the HTML.
  expect(result.mediaIds).toEqual(["media00000000000000000001", "media00000000000000000002"]);
  expect(copied.map((source) => source.url)).toEqual(["x", ""]);
  expect(result.doc.content?.map((node) => node.type)).toEqual(["paragraph", "image", "image", "orderedList"]);
  expect(result.text).toBe("Hi\n\nNot ours\nStep");
});

test("blank spacer paragraphs are dropped; content too long to store is an error", async () => {
  expect(await blocks("post", "<p>One</p><p></p><p> </p><p>Two</p>")).toEqual([p(text("One")), p(text("Two"))]);
  expect(await htmlToContent("post", `<p>${"word ".repeat(50_000)}</p>`)).toEqual({ error: "This is too long." });
});

test("parsing imported HTML requests nothing: no stylesheet, iframe or script it names", async () => {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url!);
    response.end("");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const html = `<link rel="stylesheet" href="${origin}/style.css"><iframe src="${origin}/frame"></iframe><script src="${origin}/script.js"></script><p>Hi</p>`;
    await htmlText(html);
    // The window stays open while images are copied: time for anything the HTML started to arrive.
    const { media } = fakeMedia();
    const slowMedia: HtmlOptions["media"] = async (source) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return media!(source);
    };
    await htmlToContent("article", `${html}<img src="https://example.com/a.png">`, { media: slowMedia });
    expect(requested).toEqual([]);
  } finally {
    server.close();
  }
});
