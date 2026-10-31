import { expect, test } from "vitest";

import { afterButton } from "./autopilot-words";

const progress = (status: string, waitReason: string | null = null) =>
  ({ id: "u1", kind: "moves_forward", status, waitReason, auto: false, decidedBy: null, decidedAt: null, post: { title: "Dark mode" } }) as unknown as Parameters<typeof afterButton>[0][number];

test("Publish now with every update refused doesn't say anything was published", () => {
  expect(afterButton([], "refused", "publish", null, 1)).toBe("Nothing went out: it couldn't go out as it is. It's ticked below, to check.");
  expect(afterButton([], "refused", "publish", null, 2)).toBe("Nothing went out: they couldn't go out as they are. They're ticked below, to check.");
  expect(afterButton([], "published", "publish", null, 1)).toBe("Published: what was going out by itself went now. One couldn't go out: it's ticked below, to check.");
});

test("Stop or Publish now on an update already waiting for the team says why it waits, not that it couldn't be approved", () => {
  const waiting = progress("pending", "Its article changed");
  expect(afterButton([waiting], "already", "stop", "u1", 0)).toBe("Progress update: Dark mode waits for you now (Its article changed). Check it below.");
  expect(afterButton([waiting], "already", "approve", "u1", 0)).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
});

test("Approve that can't tell whether it went, or failed for now, says so rather than done already", () => {
  const update = progress("applied");
  expect(afterButton([update], "unknown", "approve", "u1", 0)).toBe("Couldn't tell whether Progress update: Dark mode went out: check it below before doing it again.");
  expect(afterButton([progress("pending")], "failed", "approve", "u1", 0)).toBe("Couldn't approve Progress update: Dark mode just now. Try again in a moment.");
  expect(afterButton([], "unsure", "publish", null, 0, 1)).toBe("Couldn't tell whether one went out: check it below before doing it again.");
});

test("Publish now or Stop whose updates were replaced (analysed again) says so, not that nothing's going out", () => {
  expect(afterButton([progress("scheduled")], "replaced", "stop", null, 0)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: what goes out by itself now is ticked below, to stop or publish.",
  );
  // Nothing goes out by itself now: it doesn't say there is.
  expect(afterButton([progress("pending")], "replaced", "stop", null, 0)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: nothing goes out by itself now, and what it found waits for you below.",
  );
});

test("Approve refused on an update someone stopped says it couldn't be approved, not that it's done", () => {
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "approve", "u1", 0)).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "stop", "u1", 0)).toBe("Done already: Progress update: Dark mode was stopped. Nothing more to do.");
});
