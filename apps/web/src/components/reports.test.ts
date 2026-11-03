import { expect, test } from "vitest";

import { duration, niceMax, percent } from "./reports";

test("a chart's top line is 1, 2 or 5 times a power of ten, at or above the highest bar", () => {
  expect([0, 1, 2, 3, 7, 10, 11, 49, 51, 722].map(niceMax)).toEqual([1, 1, 2, 5, 10, 10, 20, 50, 100, 1000]);
});

test("a time to reply reads in minutes, hours and days", () => {
  expect([0, 59, 45 * 60, 3600, 3600 + 5 * 60, 26 * 3600, 48 * 3600].map(duration)).toEqual(["1 min", "1 min", "45 min", "1 h", "1 h 5 min", "1 d 2 h", "2 d"]);
});

test("a share with nothing to divide is a dash, not 0%", () => {
  expect([percent(0, 0), percent(1, 3), percent(2, 2)]).toEqual(["–", "33%", "100%"]);
});
