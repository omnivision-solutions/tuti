import { expect, test } from "vitest";

import { chartBars, duration, niceMax, percent } from "./reports";

test("a chart's top line is 1, 2 or 5 times a power of ten, at or above the highest bar", () => {
  expect([0, 1, 2, 3, 7, 10, 11, 49, 51, 722].map(niceMax)).toEqual([1, 1, 2, 5, 10, 10, 20, 50, 100, 1000]);
});

test("a time to reply reads in minutes, hours and days", () => {
  expect([0, 59, 45 * 60, 3600, 3600 + 5 * 60, 26 * 3600, 48 * 3600].map(duration)).toEqual(["1 min", "1 min", "45 min", "1 h", "1 h 5 min", "1 d 2 h", "2 d"]);
});

test("a share with nothing to divide is a dash, not 0%", () => {
  expect([percent(0, 0), percent(1, 3), percent(2, 2)]).toEqual(["–", "33%", "100%"]);
});

test("a chart has a bar a day up to a month, a week up to a quarter, then a month", () => {
  const days = (count: number, from = "2026-08-06") =>
    Array.from({ length: count }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  expect(chartBars(days(30))).toMatchObject({ unit: "day", bars: { length: 30 } });
  const quarter = chartBars(days(90));
  expect([quarter.unit, quarter.bars.length, quarter.bars[0], quarter.bars.at(-1)]).toEqual([
    "week",
    13,
    { label: "Aug 6", title: "Aug 6 – Aug 12", from: 0, to: 7 },
    { label: "Oct 29", title: "Oct 29 – Nov 3", from: 84, to: 90 },
  ]);
  const year = chartBars(days(365, "2025-11-04"));
  expect([year.unit, year.bars.length, year.bars[0], year.bars.at(-1)]).toEqual([
    "month",
    13,
    { label: "Nov 2025", title: "November 2025", from: 0, to: 27 },
    { label: "Nov 2026", title: "November 2026", from: 362, to: 365 },
  ]);
});
