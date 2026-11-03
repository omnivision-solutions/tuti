import { expect, test } from "vitest";

import { afterOwnSave, staysAsItWas } from "./article-saves";

test("typing kept after a save that stored the text as sent: the next save is made on that version", () => {
  expect(afterOwnSave("r1", { revision: "r2", merged: false })).toEqual({ base: "r2", seen: null, show: false, own: null });
});

test("typing kept after a save that merged Autopilot's edit in: still made on the old version, and the saved one is seen only as it's shown", () => {
  const next = afterOwnSave("r1", { revision: "r3", merged: true });
  expect(next).toEqual({ base: "r1", seen: "r3", show: true, own: "r3" });
  // Never marked seen without being shown.
  expect(next.seen === null || next.show).toBe(true);
});

test("a save that made no new version: the editor stays as it was only when its text was merged (not the newest's)", () => {
  expect(staysAsItWas({ merged: true, newVersion: false })).toBe(true);
  // Its text is the newest's: made on the newest from then on.
  expect(staysAsItWas({ merged: false, newVersion: false })).toBe(false);
  expect(staysAsItWas({ merged: true, newVersion: true })).toBe(false);
  expect(staysAsItWas(undefined)).toBe(false);
});
