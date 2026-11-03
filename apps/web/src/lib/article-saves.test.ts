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

test("a save that made no new version: the editor stays as it was unless it has the newest exactly (text and title)", () => {
  expect(staysAsItWas({ merged: true, newVersion: false, title: "Themes" }, "Themes")).toBe(true);
  // Its text and title are the newest's: made on the newest from then on.
  expect(staysAsItWas({ merged: false, newVersion: false, title: "Themes" }, "Themes")).toBe(false);
  // Renamed by a teammate (its title not sent): not the newest, so as it was (the page takes the newest up afresh).
  expect(staysAsItWas({ merged: false, newVersion: false, title: "Themes, renamed" }, "Themes")).toBe(true);
  expect(staysAsItWas({ merged: true, newVersion: true, title: "Themes" }, "Old")).toBe(false);
  expect(staysAsItWas(undefined, "Themes")).toBe(false);
});
