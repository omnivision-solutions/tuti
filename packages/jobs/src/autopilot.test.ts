import { expect, test } from "vitest";

import { checksSay } from "./autopilot";
import * as review from "./edit-review";

test("every reason the check stores is one checksSay knows, so it's worked out again rather than kept", () => {
  const reasons = Object.entries(review).filter(([name, value]) => /^CHECKS?_/.test(name) && typeof value === "string").map(([, value]) => value as string);
  expect(reasons).toContain(review.CHECK_LARGER);
  expect(reasons.filter((reason) => !checksSay(reason))).toEqual([]);
  expect(checksSay(review.checkFailed("It names the wrong button."))).toBe(true);
  // Out of credits, as stored before credits were renamed.
  expect(checksSay("It wasn't checked: AI credits ran out when it was written")).toBe(true);
  // A failed apply's message is kept.
  expect(checksSay("GitHub didn't answer")).toBe(false);
});
