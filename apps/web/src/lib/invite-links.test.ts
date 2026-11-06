import { expect, test } from "vitest";

import { keepLinks, nextRow } from "./invite-links";

const link = (email: string, n = 1) => ({ email, url: `https://tuti.example/invite/${email}-${n}` });

test("the links to pass on stay: a send adds its own, one that brought none (it failed) leaves them, a new link for an address replaces its old one", () => {
  const first = keepLinks([], [link("a")]);
  expect(first).toEqual([link("a")]);
  const both = keepLinks(first, [link("b")]);
  expect(both).toEqual([link("a"), link("b")]);
  expect(keepLinks(both, undefined)).toBe(both);
  expect(keepLinks(both, [])).toBe(both);
  expect(keepLinks(both, [link("a", 2), link("c")])).toEqual([link("b"), link("a", 2), link("c")]);
});

test("after a row's Send or Remove, focus goes to the next row, none after the last or for Send all", () => {
  expect(nextRow(["a", "b", "c"], "a")).toBe("b");
  expect(nextRow(["a", "b", "c"], "c")).toBeNull();
  expect(nextRow(["a", "b"], null)).toBeNull();
});
