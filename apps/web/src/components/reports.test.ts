import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { reportRange } from "@/lib/report-range";

import { chartBars, countTrend, DailyChart, duration, niceMax, percent, shareTrend, timeTrend } from "./reports";

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
  expect(chartBars(days(30), "2026-11-03")).toMatchObject({ unit: "day", bars: { length: 30 } });
  const quarter = chartBars(days(90), "2026-12-01");
  expect([quarter.unit, quarter.bars.length, quarter.bars[0], quarter.bars.at(-1)]).toEqual([
    "week",
    13,
    { label: "Aug 6", title: "Aug 6 – Aug 12", from: 0, to: 7 },
    { label: "Oct 29", title: "Oct 29 – Nov 3", from: 84, to: 90 },
  ]);
  const year = chartBars(days(365, "2025-11-04"), "2026-12-01");
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
  // Less than one before (today's first hours count a sliver of the day before): too little to compare with.
  expect(countTrend(week, days(1), 0.05, "up").change).toBeNull();
  expect(shareTrend(week, days(1), days(1), { part: 0.05, whole: 0.05 }, "up").change).toBeNull();
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
  // Its last week is under way (today is in it): left out, or it would read as a fall.
  expect(countTrend(quarter, ones, null).line).toEqual(Array.from({ length: 12 }, () => 7));
  expect(countTrend({ ...quarter, today: "2026-12-01" }, ones, null).line).toEqual([...Array.from({ length: 12 }, () => 7), 6]);
  const week = reportRange("7d", new Date("2026-11-03T12:00:00Z"));
  expect(shareTrend({ ...week, today: "2026-11-04" }, [1, 0, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 0, 4], null).line).toEqual([50, null, null, null, null, null, 25]);
  // Today, under way, left out; a range of a day or two keeps it.
  expect(shareTrend(week, [1, 0, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 0, 4], null).line).toEqual([50, null, null, null, null, null]);
  expect(countTrend(reportRange("month", new Date("2026-11-02T12:00:00Z")), [1, 2], null).line).toEqual([1, 2]);
});

test("a chart's last bar, when it holds today, is a period under way: marked so far", () => {
  const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
  expect(chartBars(days, "2026-11-03").bars.at(-1)).toEqual({ label: "Nov 3", title: "Nov 3 (so far)", from: 2, to: 3, soFar: true });
  expect(chartBars(days, "2026-11-04").bars.at(-1)?.soFar).toBeUndefined();
  // Past year's month, three days into it.
  const year = Array.from({ length: 365 }, (_, i) => new Date(Date.parse("2025-11-04T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10));
  expect(chartBars(year, "2026-11-03").bars.at(-1)).toMatchObject({ title: "Nov 1 – Nov 3, 2026 (so far)", soFar: true });
  expect(chartBars(year, "2026-11-03").bars.filter((bar) => bar.soFar)).toHaveLength(1);
});

test("a single day (Today, Yesterday) has no chart: one bar says nothing its numbers don't", () => {
  const series = (n: number) => [{ label: "Article views", values: Array.from({ length: n }, () => 1) }];
  expect(DailyChart({ title: "Article views", days: ["2026-11-03"], today: "2026-11-03", series: series(1) })).toBeNull();
  expect(DailyChart({ title: "Article views", days: ["2026-11-02", "2026-11-03"], today: "2026-11-03", series: series(2) })).not.toBeNull();
});

test("a chart marks its bar for today so far, in its words and its look; a past range's last bar is whole", () => {
  const chart = (today: string) =>
    renderToStaticMarkup(DailyChart({ title: "Article views", days: ["2026-11-02", "2026-11-03"], today, series: [{ label: "Article views", values: [4, 2] }] }));
  const under = chart("2026-11-03");
  expect(under).toContain('aria-label="Nov 3 (so far): Article views 2"');
  expect(under).toContain("Nov 3, so far");
  expect(under.match(/border-series-1/g)).toHaveLength(1);
  const past = chart("2026-11-04");
  expect(past).toContain('aria-label="Nov 3: Article views 2"');
  expect(past).not.toContain("so far");
  expect(past).not.toContain("border-series-1");
});
