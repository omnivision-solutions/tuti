import { expect, test } from "vitest";

import { timeAgo } from "./format";

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
