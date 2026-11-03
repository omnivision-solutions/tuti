import { expect, test } from "vitest";

import { reportRange } from "@/lib/report-range";

import { chartBars, countTrend, duration, niceMax, percent, shareTrend, timeTrend } from "./reports";

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
    { label: "Nov 2025", title: "Nov 4 – Nov 30, 2025", from: 0, to: 27 },
    { label: "Nov 2026", title: "Nov 1 – Nov 3, 2026", from: 362, to: 365 },
  ]);
  // A whole month in between is named as one.
  expect(year.bars[1]).toMatchObject({ label: "Dec 2025", title: "December 2025" });
});

test("a tile's change is on as many days just before, coloured by whether that's better", () => {
  const week = reportRange("7d", new Date("2026-11-03T12:00:00Z"));
  const days = (total: number) => [0, 0, 0, 0, 0, 0, total];
  expect(countTrend(week, days(12), 10, "up").change).toEqual({ direction: "up", text: "20%", said: "Up 20% on the 7 days before", tone: "better" });
  expect(countTrend(week, days(5), 10, "up").change).toMatchObject({ direction: "down", text: "50%", tone: "worse" });
  expect(countTrend(week, days(12), 10, "down").change?.tone).toBe("worse");
  expect(countTrend(week, days(12), 10).change?.tone).toBe("neither");
  expect(countTrend(week, days(10), 10, "up").change).toMatchObject({ direction: "same", said: "Same as the 7 days before", tone: "neither" });
  // Nothing (or not known) before: no change to show.
  expect(countTrend(week, days(3), 0, "up").change).toBeNull();
  expect(countTrend(week, days(3), null, "up").change).toBeNull();
  expect(countTrend(reportRange("today"), [3], 1).change?.said).toBe("Up 200% on the day before");
  // A share: in percentage points, between the percentages the tiles show (75% and 50%).
  expect(shareTrend(week, days(3), days(4), { part: 1, whole: 2 }, "up").change).toMatchObject({ text: "25 pts", tone: "better" });
  expect(shareTrend(week, days(0), days(0), { part: 1, whole: 2 }, "up").change).toBeNull();
  // A time: shorter is better.
  expect(timeTrend(week, 1800, 3600, "down").change).toMatchObject({ direction: "down", text: "50%", tone: "better" });
  expect(timeTrend(week, null, 3600, "down").change).toBeNull();
});

test("a tile's line sums the range's days as its chart's bars do; a share's days with nothing to divide are left out", () => {
  const quarter = reportRange("quarter", new Date("2026-11-03T12:00:00Z"));
  const ones = Array.from({ length: 90 }, () => 1);
  expect(countTrend(quarter, ones, null).line).toEqual([...Array.from({ length: 12 }, () => 7), 6]);
  const week = reportRange("7d", new Date("2026-11-03T12:00:00Z"));
  expect(shareTrend(week, [1, 0, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 0, 4], null).line).toEqual([50, null, null, null, null, null, 25]);
});
