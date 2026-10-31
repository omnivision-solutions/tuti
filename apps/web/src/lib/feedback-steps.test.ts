import { expect, test } from "vitest";

import { feedbackStep, sameFeedbackList } from "./feedback-steps";

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
  // A post that arrived meanwhile above it (the newest, sorting first) isn't where J goes: J doesn't jump back up.
  const arrived = [99, ...before.slice(0, 49)];
  expect(feedbackStep(arrived, before, 50, 1)).toBeNull();
  expect(feedbackStep([99, ...before.slice(0, 49), 51], before, 50, 1)).toBe(51);
});

test("more of the list loaded is the same list; another filter isn't", () => {
  expect(sameFeedbackList("/app/acme/feedback?status=open", "/app/acme/feedback?status=open&page=2")).toBe(true);
  expect(sameFeedbackList("/app/acme/feedback?board=bugs&status=all", "/app/acme/feedback?status=all&board=bugs")).toBe(true);
  expect(sameFeedbackList("/app/acme/feedback?status=open", "/app/acme/feedback?status=open&board=bugs")).toBe(false);
});
