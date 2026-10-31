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
