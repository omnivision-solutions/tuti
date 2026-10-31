import { expect, test } from "vitest";

import { goesOutAt } from "./goes-out";

test("when a scheduled update goes out, by day, in the reader's time", () => {
  const now = new Date(2026, 9, 31, 10, 0);
  expect(goesOutAt(new Date(2026, 9, 31, 15, 10), now)).toMatch(/^today at 3:10\s?pm$/);
  expect(goesOutAt(new Date(2026, 10, 1, 9, 0), now)).toMatch(/^tomorrow at 9:00\s?am$/);
  expect(goesOutAt(new Date(2026, 10, 3, 9, 0), now)).toMatch(/^on .+ at 9:00\s?am$/);
  expect(goesOutAt(new Date(2026, 9, 31, 9, 0), now)).toBe("in a moment");
});
