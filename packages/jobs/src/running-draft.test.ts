import { expect, test } from "vitest";

import { onlyPullRequestTitles } from "./running-draft";

const pr = { repo: "acme/app", number: 1, title: "Add a dark theme" };
const item = (...content: object[]) => ({ type: "listItem", content });
const paragraph = (text?: string) => ({ type: "paragraph", ...(text && { content: [{ type: "text", text }] }) });
const list = (...items: object[]) => ({ type: "doc", content: [{ type: "bulletList", content: items }] });

test("an empty bullet beside the titles is nothing written; one holding only an image is", () => {
  expect(onlyPullRequestTitles(list(item(paragraph("Add a dark theme (acme/app#1)")), item(paragraph())), [pr])).toBe(true);
  expect(onlyPullRequestTitles(list(item(paragraph("Add a dark theme (acme/app#1)")), item(paragraph(), { type: "image", attrs: { src: "/x.png" } })), [pr])).toBe(false);
});

test("a paragraph holding only a space or a line break beside the titles is nothing written; one holding text is", () => {
  const titles = { type: "bulletList", content: [item(paragraph("Add a dark theme (acme/app#1)"))] };
  const blankParagraphs = [paragraph(" "), { type: "paragraph", content: [{ type: "hardBreak" }] }];
  expect(onlyPullRequestTitles({ type: "doc", content: [titles, ...blankParagraphs] }, [pr])).toBe(true);
  expect(onlyPullRequestTitles({ type: "doc", content: [titles, paragraph("Dark mode is here.")] }, [pr])).toBe(false);
});

test("an empty heading or quote beside the titles is nothing written; one with text is", () => {
  const titles = { type: "bulletList", content: [item(paragraph("Add a dark theme (acme/app#1)"))] };
  const heading = (text?: string) => ({ type: "heading", attrs: { level: 2 }, ...(text && { content: [{ type: "text", text }] }) });
  const quote = { type: "blockquote", content: [paragraph()] };
  expect(onlyPullRequestTitles({ type: "doc", content: [titles, heading(), quote] }, [pr])).toBe(true);
  expect(onlyPullRequestTitles({ type: "doc", content: [titles, heading("Dark mode"), quote] }, [pr])).toBe(false);
});

test("a bullet left with only a line break and an empty list inside it is nothing written; an image in that list is", () => {
  const leftover = (...nested: object[]) =>
    item({ type: "paragraph", content: [{ type: "hardBreak" }] }, { type: "bulletList", content: [item(paragraph(), ...nested)] });
  expect(onlyPullRequestTitles(list(item(paragraph("Add a dark theme (acme/app#1)")), leftover()), [pr])).toBe(true);
  expect(onlyPullRequestTitles(list(item(paragraph("Add a dark theme (acme/app#1)")), leftover({ type: "image", attrs: { src: "/x.png" } })), [pr])).toBe(false);
});
