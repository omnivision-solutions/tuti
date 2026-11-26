import type { Doc } from "@tuti/content";
import { expect, test } from "vitest";

import { screenshotsAsked } from "./screenshot-lines";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...texts: string[]) => ({ type: "doc", content: texts.map(paragraph) }) as Doc;

test("the lines asked for: each a paragraph of its own, as written; one inside a sentence, left open or another kind isn't", () => {
  expect(screenshotsAsked(doc("[Screenshot: The billing page]", "[ screenshot :  Settings → Team ]", "See [Screenshot: inline]", "[Screenshot: open", "[Check: a fact]", "[Screenshot: ]"))).toEqual([
    "The billing page",
    "Settings → Team",
  ]);
});

test("a line is read without backtracking, however long (a run of spaces after the colon)", () => {
  const started = performance.now();
  expect(screenshotsAsked(doc(`[screenshot:${" ".repeat(200_000)}x`, `[screenshot:${" ".repeat(200_000)}]`))).toEqual([]);
  // A wide margin: the old pattern took over a minute on a tenth of this; any machine reads it in well under.
  expect(performance.now() - started).toBeLessThan(10_000);
});

test("a long line is read whole: two alike up to 500 characters aren't the same line", () => {
  const start = "a".repeat(500);
  expect(screenshotsAsked(doc(`[Screenshot: ${start} first]`, `[Screenshot: ${start} second]`))).toEqual([`${start} first`, `${start} second`]);
});
