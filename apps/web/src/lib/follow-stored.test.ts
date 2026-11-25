import { expect, test } from "vitest";

import { keptEdit, onRefresh, pendingAfterSave } from "./follow-stored";

test("an edit that matches the stored value is dropped, whenever it does (typed before the page caught up included)", () => {
  expect(keptEdit("https://api.example.com/openapi.json ", "https://api.example.com/openapi.json")).toBeNull();
  expect(keptEdit("https://api.example.com/v2.json", "https://api.example.com/openapi.json")).toBe("https://api.example.com/v2.json");
  expect(keptEdit(null, "https://api.example.com/openapi.json")).toBeNull();
});

test("a save's own late refresh doesn't undo a pick made since; every other refresh is followed", () => {
  // Saved "custom", then removed it before the refresh came: the refresh doesn't put it back, and the wait ends.
  let pending = pendingAfterSave<string | null>("custom", "chat");
  expect(onRefresh(pending, "custom")).toEqual({ pending: null, follow: false });

  // A teammate's save lands first: followed, and the wait goes on for this page's own.
  expect(onRefresh(pending, "help")).toEqual({ pending, follow: true });

  // A teammate removes the icon with nothing waiting: followed ("no icon" isn't "nothing waiting").
  expect(onRefresh<string | null>(null, null)).toEqual({ pending: null, follow: true });

  // Saving other fields with the icon unchanged waits for nothing, so a teammate's change away and back is followed.
  pending = pendingAfterSave<string | null>("chat", "chat");
  expect(pending).toBeNull();
  expect(onRefresh(pending, "help").follow).toBe(true);
  expect(onRefresh(pending, "chat").follow).toBe(true);
});
