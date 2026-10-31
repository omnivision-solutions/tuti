import { expect, test } from "vitest";

import { feedbackStep } from "./feedback-steps";

test("J and K go to the next and previous post; J opens the first with none open", () => {
  expect(feedbackStep([1, 2, 3], [1, 2, 3], 2, 1)).toBe(3);
  expect(feedbackStep([1, 2, 3], [1, 2, 3], 2, -1)).toBe(1);
  expect(feedbackStep([1, 2, 3], [1, 2, 3], null, 1)).toBe(1);
  expect(feedbackStep([1, 2, 3], [1, 2, 3], 3, 1)).toBeNull();
  expect(feedbackStep([1, 2, 3], [1, 2, 3], 1, -1)).toBeNull();
});

test("triaged out of the list, they go on from where it stood", () => {
  expect(feedbackStep([1, 2, 4], [1, 2, 3, 4], 3, 1)).toBe(4);
  expect(feedbackStep([1, 2, 4], [1, 2, 3, 4], 3, -1)).toBe(2);
  // Another list (filtered): J opens its first.
  expect(feedbackStep([5, 6], [5, 6], 3, 1)).toBe(5);
});

test("the last loaded post triaged, J opens the one that moved up from the next page", () => {
  const before = Array.from({ length: 50 }, (_, i) => i + 1);
  const after = [...before.slice(0, 49), 51];
  expect(feedbackStep(after, before, 50, 1)).toBe(51);
  expect(feedbackStep(after, before, 50, -1)).toBe(49);
});
