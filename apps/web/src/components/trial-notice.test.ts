import { expect, test } from "vitest";

import { daysLeft } from "./trial-notice";

test("days left in a trial: a part of a day counts as one, and never fewer than one", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const ahead = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  expect([daysLeft(ahead(7 * 24), now), daysLeft(ahead(6.5 * 24), now), daysLeft(ahead(1), now), daysLeft(ahead(-1), now)]).toEqual([7, 7, 1, 1]);
});
