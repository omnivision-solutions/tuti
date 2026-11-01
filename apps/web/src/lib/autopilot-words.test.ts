import { describe, expect, it, test } from "vitest";

import { afterButton, stateBadge } from "./autopilot-words";

const progress = (status: string, waitReason: string | null = null) =>
  ({ id: "u1", kind: "moves_forward", status, waitReason, auto: false, decidedBy: null, decidedAt: null, post: { title: "Dark mode" } }) as unknown as Parameters<typeof afterButton>[0][number];

test("Publish now with every update refused doesn't say anything was published", () => {
  expect(afterButton([], "refused", "publish", null, { held: 1 })).toBe("Nothing went out: it couldn't go out as it is. It's ticked below, to check.");
  expect(afterButton([], "refused", "publish", null, { held: 2 })).toBe("Nothing went out: they couldn't go out as they are. They're ticked below, to check.");
  expect(afterButton([], "published", "publish", null, { held: 1 })).toBe("Published: what was going out by itself went now. One couldn't go out: it's ticked below, to check.");
});

test("Stop or Publish now on an update already waiting for the team says why it waits, not that it couldn't be approved", () => {
  const waiting = progress("pending", "Its article changed");
  expect(afterButton([waiting], "already", "stop", "u1")).toBe("Progress update: Dark mode waits for you now (Its article changed). Check it below.");
  expect(afterButton([waiting], "already", "approve", "u1")).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
});

test("Approve that can't tell whether it went, or failed for now, says so rather than done already", () => {
  const update = progress("applied");
  expect(afterButton([update], "unknown", "approve", "u1")).toBe("Couldn't tell whether Progress update: Dark mode went out: check it below before doing it again.");
  expect(afterButton([progress("pending")], "failed", "approve", "u1")).toBe("Couldn't approve Progress update: Dark mode just now. Try again in a moment.");
  expect(afterButton([], "unsure", "publish", null, { unsure: 1 })).toBe("Couldn't tell whether one went out: check it below before doing it again.");
});

test("Publish now or Stop whose updates were replaced (analysed again) says so, not that nothing's going out", () => {
  expect(afterButton([progress("scheduled")], "replaced", "stop", null)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: what goes out by itself now is below, marked In your email, with Publish now and Stop.",
  );
  // Nothing goes out by itself now: it doesn't say there is.
  expect(afterButton([progress("pending")], "replaced", "stop", null)).toBe(
    "Those updates were replaced when Autopilot read the pull request again: nothing goes out by itself now, and what it found waits for you below.",
  );
});

test("Approve refused on an update someone stopped says it couldn't be approved, not that it's done", () => {
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "approve", "u1")).toBe("Progress update: Dark mode couldn't be approved as it is. Check it below.");
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "stop", "u1")).toBe("Done already: Progress update: Dark mode was stopped. Nothing more to do.");
  // Publish now on it: it didn't go, and it waits.
  expect(afterButton([progress("pending", "Stopped by Bob")], "already", "publish", "u1")).toBe("Progress update: Dark mode waits for you now (Stopped by Bob). Check it below.");
});

test("done already names the update, and says the others someone decided first, not counting it twice", () => {
  // Publish now: the one named went out (by a teammate), another was stopped.
  expect(afterButton([progress("applied")], "already", "publish", "u1", { kept: 1 })).toBe(
    "Done already: Progress update: Dark mode was approved. Nothing more to do. One was stopped: it waits for you below.",
  );
  // Stop: the one named went out; Undo is what's left (and it isn't counted again).
  expect(afterButton([progress("applied")], "already", "stop", "u1", { went: 1 })).toBe("Progress update: Dark mode went out already: it's under Done, to undo there.");
});

test("Stop or Publish now says which of the others it named someone decided first: went out already, or stopped", () => {
  expect(afterButton([], "stopped", "stop", null, { went: 1 })).toBe("Stopped: those updates wait for you now. One went out already: it's under Done, to undo there.");
  expect(afterButton([], "published", "publish", null, { kept: 2 })).toBe("Published: what was going out by itself went now. 2 were stopped: they wait for you below.");
});

test("nothing acted on (refused, or can't tell) still says which others went out already or were stopped", () => {
  expect(afterButton([], "refused", "stop", null, { held: 1, went: 1 })).toBe(
    "Nothing was stopped: it couldn't be stopped as it is. It's ticked below, to check. One went out already: it's under Done, to undo there.",
  );
  expect(afterButton([], "unsure", "publish", null, { unsure: 1, kept: 1 })).toBe(
    "Couldn't tell whether one went out: check it below before doing it again. One was stopped: it waits for you below.",
  );
});

describe("stateBadge", () => {
  it("says how many updates wait, whatever the change's state (one the team stopped outlives nothing to do)", () => {
    expect(stateBadge({ state: "ready", waiting: 2 })).toEqual({ label: "2 to review", variant: "highlight" });
    expect(stateBadge({ state: "nothing_to_do", waiting: 1 })).toEqual({ label: "1 to review", variant: "highlight" });
  });

  it("else why it's there, or nothing for one reviewed", () => {
    expect(stateBadge({ state: "failed", waiting: 0 })).toEqual({ label: "Failed", variant: "destructive" });
    expect(stateBadge({ state: "analysing", waiting: 0 })?.label).toBe("Analysing");
    expect(stateBadge({ state: "paused", waiting: 0 })?.label).toBe("Paused");
    expect(stateBadge({ state: "ready", waiting: 0 })).toBeNull();
    expect(stateBadge({ state: "nothing_to_do", waiting: 0 })).toBeNull();
  });
});
