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
