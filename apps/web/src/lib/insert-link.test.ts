import { expect, test } from "vitest";

import { insertLink } from "./insert-link";

const article = { title: "Refunds", url: "https://acme.example/docs/refunds" };
const link = "Refunds: https://acme.example/docs/refunds";
/** The text with `|` where the cursor goes. */
const at = (text: string, start: number, end = start) => {
  const result = insertLink(text, start, end, article);
  return `${result.text.slice(0, result.caret)}|${result.text.slice(result.caret)}`;
};

test("at a space, the link goes in as it is, the cursor at its end", () => {
  expect(at("See  for steps.", 4)).toBe(`See ${link}| for steps.`);
});

test("mid-word, a space either side keeps it apart from the word", () => {
  expect(at("Seefor", 3)).toBe(`See ${link}| for`);
});

test("at the start and the end, no space where there's nothing to keep apart from", () => {
  expect(at("", 0)).toBe(`${link}|`);
  expect(at("thanks", 0)).toBe(`${link}| thanks`);
  expect(at("See", 3)).toBe(`See ${link}|`);
  expect(at("See ", 4)).toBe(`See ${link}|`);
});

test("selected text is replaced by the link", () => {
  expect(at("See this page for steps.", 4, 13)).toBe(`See ${link}| for steps.`);
  expect(at("all of it", 0, 9)).toBe(`${link}|`);
});
