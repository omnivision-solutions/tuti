import { describe, expect, test } from "vitest";

import { postNumberFromParam, postPath, titleSlug } from "./post-urls";

describe("titleSlug", () => {
  test.each([
    ["Dark mode", "dark-mode"],
    ["  Crème brûlée!!  ", "creme-brulee"],
    ["C++ & Rust", "c-rust"],
    ["🎉", "post"],
    ["", "post"],
  ])("%j → %j", (title, slug) => {
    expect(titleSlug(title)).toBe(slug);
  });

  test("cuts long titles to 60 characters without a trailing dash", () => {
    const slug = titleSlug(`${"a".repeat(59)} b`);
    expect(slug).toBe("a".repeat(59));
  });
});

test("postPath is under the post's board and ends with its number", () => {
  expect(postPath({ title: "Dark mode", number: 12, board: { slug: "ideas" } })).toBe("/feedback/ideas/dark-mode-12");
});

describe("postNumberFromParam", () => {
  test.each([
    ["dark-mode-12", 12],
    ["12", 12],
    ["2024-roadmap-7", 7],
    ["dark-mode", null],
    ["dark-mode-", null],
    ["x-1234567890", null],
  ])("%j → %j", (param, number) => {
    expect(postNumberFromParam(param)).toBe(number);
  });

  test("round-trips with postPath, even for titles ending in a number", () => {
    const path = postPath({ title: "Support for 2024", number: 5, board: { slug: "ideas" } });
    expect(postNumberFromParam(path.split("/").at(-1)!)).toBe(5);
  });
});
