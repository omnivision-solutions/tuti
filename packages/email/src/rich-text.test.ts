import { render } from "@react-email/render";
import type { Doc } from "@tuti/content";
import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { changelogEmail } from "./changelog-email";
import { EmailRichText } from "./rich-text";

const doc = (...content: object[]) => ({ type: "doc", content }) as Doc;
const p = (...content: object[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks && { marks }) });
const link = (href: string) => ({ type: "link", attrs: { href } });
const item = (value: string) => ({ type: "listItem", content: [p(text(value))] });
const MEDIA_ID = "clx0abcdefghijklmnopqrstu";
const image = (attrs: object = {}) => ({
  type: "image",
  attrs: { mediaId: MEDIA_ID, width: "100", align: "center", alt: "A chart", w: 1600, h: 800, ...attrs },
});
const video = { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } };
const ENTRY = "https://acme.example.com/changelog/dark-mode";
const MEDIA = "https://media.example.com";

const html = (d: Doc, mediaBaseUrl?: string) => render(createElement(EmailRichText, { doc: d, mediaBaseUrl, linkUrl: ENTRY }));
const plain = (d: Doc, mediaBaseUrl?: string) =>
  render(createElement(EmailRichText, { doc: d, mediaBaseUrl, linkUrl: ENTRY }), { plainText: true });

// Every node and mark the changelog profile (a superset of post and comment) allows.
const everything = doc(
  { type: "heading", attrs: { level: 2 }, content: [text("Big news")] },
  { type: "heading", attrs: { level: 3 }, content: [text("Details")] },
  p(text("Bold", [{ type: "bold" }]), text(" and "), text("italic", [{ type: "italic" }]), text(" and "), text("x = 1", [{ type: "code" }])),
  p(text("Line one"), { type: "hardBreak" }, text("line two"), text(" see "), text("the docs", [link("https://example.com/docs")])),
  { type: "bulletList", content: [item("First bullet"), item("Second bullet")] },
  { type: "orderedList", attrs: { start: 3 }, content: [item("Third step")] },
  { type: "codeBlock", content: [text("const a = 1;\nconst b = 2;")] },
  { type: "blockquote", content: [p(text("A quote"))] },
  { type: "horizontalRule" },
  image(),
  video,
);

describe("EmailRichText", () => {
  test("renders every node and mark with inline styles", async () => {
    const out = await html(everything, MEDIA);
    expect(out).toMatch(/<h2 style="[^"]+">Big news<\/h2>/);
    expect(out).toMatch(/<h3 style="[^"]+">Details<\/h3>/);
    expect(out).toContain("<strong>Bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toMatch(/<code style="[^"]+">x = 1<\/code>/);
    expect(out).toContain("Line one<br/>line two");
    expect(out).toMatch(/<a href="https:\/\/example.com\/docs" style="[^"]+">the docs<\/a>/);
    expect(out).toMatch(/<ul style="[^"]+"><li style="[^"]+"><p style="[^"]+">First bullet<\/p><\/li>/);
    expect(out).toMatch(/<ol start="3" style="[^"]+"><li style="[^"]+"><p style="[^"]+">Third step<\/p>/);
    expect(out).toMatch(/<pre style="[^"]+"><code>const a = 1;\nconst b = 2;<\/code><\/pre>/);
    expect(out).toMatch(/<blockquote style="[^"]+"><p style="[^"]+">A quote<\/p><\/blockquote>/);
    expect(out).toMatch(/<hr style="[^"]+"\/>/);
    expect(out).not.toMatch(/<(iframe|script|style|link)\b/);
    expect(out).not.toContain("class=");
  });

  test("escapes text: content never becomes markup", async () => {
    const out = await html(doc(p(text('<script>alert(1)</script><img src=x onerror="alert(2)">'))));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("unsafe links render as plain text", async () => {
    const out = await html(doc(p(text("click me", [link("javascript:alert(1)")]), text(" or "), text("this", [link("data:text/html,x")]))));
    expect(out).not.toContain("<a");
    expect(out).not.toContain("javascript:");
    expect(out).toMatch(/click me.* or .*this/);
  });

  test("images use the email JPEG, sized to the column and their share of it", async () => {
    const out = await html(doc(image(), image({ width: "50", align: "right", alt: 'Say "hi"' })), MEDIA);
    expect(out).toContain(`src="${MEDIA}/m/${MEDIA_ID}/email.jpg"`);
    expect(out).toMatch(/alt="A chart" width="384" height="192"/);
    expect(out).toMatch(/text-align:right"><img [^>]*alt="Say &quot;hi&quot;" width="192" height="96"/);
    expect(out).toContain("max-width:100%");
    // A small image isn't stretched.
    expect(await html(doc(image({ w: 200, h: 100 })), MEDIA)).toMatch(/width="200" height="100"/);
  });

  test("images are left out without a media URL or with a bad id", async () => {
    expect(await html(doc(image()))).not.toContain("<img");
    expect(await html(doc(image({ mediaId: "../../etc/passwd" })), MEDIA)).not.toContain("<img");
    expect(await html(doc(image({ w: 0 })), MEDIA)).not.toContain("<img");
  });

  test("videos become a link to the entry, never an iframe", async () => {
    const out = await html(doc(video));
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("youtube");
    expect(out).toMatch(new RegExp(`<a href="${ENTRY}"[^>]*>.*Watch the video`));
    expect(await html(doc({ type: "video", attrs: { provider: "evil", id: "x" } }))).not.toContain("<a");
  });

  test("plain text stays readable", async () => {
    const out = await plain(everything, MEDIA);
    for (const line of ["BIG NEWS", "First bullet", "Third step", "const a = 1;", "A quote", "Watch the video"]) {
      expect(out).toContain(line);
    }
    expect(out).toContain("the docs https://example.com/docs");
    expect(out).toContain(`Watch the video ${ENTRY}`);
    expect(out).not.toMatch(/<[a-z]/);
  });
});

describe("changelogEmail", () => {
  test("subject and body", async () => {
    const email = changelogEmail({
      projectName: "Acme",
      entryTitle: "Dark mode",
      entryUrl: ENTRY,
      doc: doc(p(text("Easier on the eyes.")), image()),
      mediaBaseUrl: MEDIA,
      unsubscribeUrl: "https://acme.example.com/unsubscribe?token=t",
    });
    expect(email.subject).toBe("Acme: Dark mode");
    const out = await render(email.body);
    expect(out).toContain("Dark mode</h1>");
    expect(out).toContain("Easier on the eyes.");
    expect(out).toContain(`${MEDIA}/m/${MEDIA_ID}/email.jpg`);
    expect(out).toContain(`href="${ENTRY}"`);
    expect(out).toContain('href="https://acme.example.com/unsubscribe?token=t"');
  });
});
