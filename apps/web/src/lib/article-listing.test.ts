import { expect, test } from "vitest";

import { embedNote } from "./article-listing";

test("the embed note says when the widget can't open the article: a draft until it's published, Hidden and AI only never", () => {
  expect(embedNote(true, "everywhere")).toBe("");
  expect(embedNote(true, "unlisted")).toBe("");
  expect(embedNote(false, "everywhere")).toBe(" It opens once the article is published.");
  expect(embedNote(true, "hidden")).toBe(" It doesn't open while the article is Hidden.");
  expect(embedNote(false, "ai_only")).toBe(" It doesn't open while the article is AI only.");
});
