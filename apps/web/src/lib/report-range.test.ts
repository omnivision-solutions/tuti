import { expect, test } from "vitest";

import { reportRange } from "./report-range";

const now = new Date("2026-11-03T15:00:00Z");
const span = (key: string | undefined) => {
  const range = reportRange(key, now);
  return [range.since.toISOString().slice(0, 10), range.until.toISOString().slice(0, 10), range.days.length, range.days[0], range.days.at(-1)];
};

test("each range is whole UTC days, its last day the one before `until`", () => {
  expect(span("today")).toEqual(["2026-11-03", "2026-11-04", 1, "2026-11-03", "2026-11-03"]);
  expect(span("yesterday")).toEqual(["2026-11-02", "2026-11-03", 1, "2026-11-02", "2026-11-02"]);
  expect(span("month")).toEqual(["2026-11-01", "2026-11-04", 3, "2026-11-01", "2026-11-03"]);
  expect(span("last-month")).toEqual(["2026-10-01", "2026-11-01", 31, "2026-10-01", "2026-10-31"]);
  expect(span("7d")).toEqual(["2026-10-28", "2026-11-04", 7, "2026-10-28", "2026-11-03"]);
  expect(span("quarter")).toEqual(["2026-08-06", "2026-11-04", 90, "2026-08-06", "2026-11-03"]);
  expect(span("year")).toEqual(["2025-11-04", "2026-11-04", 365, "2025-11-04", "2026-11-03"]);
});

test("the past 30 days unless a known range is asked for", () => {
  expect(span(undefined)).toEqual(["2026-10-05", "2026-11-04", 30, "2026-10-05", "2026-11-03"]);
  expect(span("forever")).toEqual(span("30d"));
  expect(reportRange("14d", now).label).toBe("Past 14 days");
});

test("last month in January is December of the year before", () => {
  const range = reportRange("last-month", new Date("2027-01-10T08:00:00Z"));
  expect([range.since.toISOString(), range.until.toISOString(), range.days.length]).toEqual(["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", 31]);
});

test("a range is compared with as many days just before it", () => {
  const previous = (key: string) => {
    const range = reportRange(key, now);
    return [range.previous.since.toISOString().slice(0, 10), range.previous.days.length, range.previous.days.at(-1)];
  };
  expect(previous("today")).toEqual(["2026-11-02", 1, "2026-11-02"]);
  expect(previous("month")).toEqual(["2026-10-29", 3, "2026-10-31"]);
  expect(previous("last-month")).toEqual(["2026-08-31", 31, "2026-09-30"]);
  expect(previous("30d")).toEqual(["2026-09-05", 30, "2026-10-04"]);
});
