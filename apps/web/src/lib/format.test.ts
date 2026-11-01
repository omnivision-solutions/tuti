import { expect, test } from "vitest";

import { asking, askingTotal, shortDuration, timeAgo } from "./format";

const now = new Date("2026-10-18T12:00:00Z");
const ago = (seconds: number) => timeAgo(new Date(now.getTime() - seconds * 1000), now);

test.each([
  [10, "just now"],
  [60, "1 minute ago"],
  [2 * 3600, "2 hours ago"],
  [24 * 3600, "yesterday"],
  [3 * 24 * 3600, "3 days ago"],
  [14 * 24 * 3600, "2 weeks ago"],
  [400 * 24 * 3600, "last year"],
])("%i seconds → %j", (seconds, text) => {
  expect(ago(seconds)).toBe(text);
});

test.each([
  [30, "1m"],
  [45 * 60, "45m"],
  [3 * 3600 + 59 * 60, "3h"],
  [49 * 3600, "2d"],
])("shortDuration: %i seconds → %j", (seconds, text) => {
  expect(shortDuration(new Date(now.getTime() - seconds * 1000), now)).toBe(text);
});

test("Who's asking: totals with up to two decimals, small ones with their digits", () => {
  expect(asking(1500.5, "mrr")).toBe("1,500.5 mrr");
  expect(asking(12400, "mrr")).toBe("12,400 mrr");
  expect(asking(0.004, "mrr")).toBe("0.004 mrr");
  expect(asking(0.12345, "seats")).toBe("0.123 seats");
  // In the team's name and format for it.
  expect(asking(12400, "mrr", { mrr: { label: "MRR", format: "money" } })).toBe("$12,400 MRR");
  expect(asking(12400.5, "seats", { seats: { format: "number" } })).toBe("12,400.5 seats");
  // The number on its own, for a column headed with the property (Companies): a small one kept too.
  expect(askingTotal(0.004, "mrr")).toBe("0.004");
  expect(askingTotal(12400, "mrr", { mrr: { format: "money" } })).toBe("$12,400");
});
