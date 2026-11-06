import { expect, test } from "vitest";

import { mergeExposure } from "./visibility-labels";

test("a merge's dialog says when the merged post's comments will be seen by more people", () => {
  expect(mergeExposure("PRIVATE", "PUBLIC", 9)).toBe("It's Private: its comments will be seen by everyone who sees #9.");
  expect(mergeExposure("TEAM", "PRIVATE", 9)).toBe("It's Team only: its comments will be seen by everyone who sees #9.");
  // As widely seen, or less: nothing to say.
  expect(mergeExposure("PUBLIC", "PRIVATE", 9)).toBeNull();
  expect(mergeExposure("PRIVATE", "PRIVATE", 9)).toBeNull();
  expect(mergeExposure(undefined, "PUBLIC", 9)).toBeNull();
});
