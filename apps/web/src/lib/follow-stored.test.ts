import { expect, test } from "vitest";

import { keptEdit, onRefresh, pendingAfterSave, pickedSince } from "./follow-stored";

test("an edit that matches the stored value is dropped, whenever it does (typed before the page caught up included)", () => {
  expect(keptEdit("https://api.example.com/openapi.json ", "https://api.example.com/openapi.json")).toBeNull();
  expect(keptEdit("https://api.example.com/v2.json", "https://api.example.com/openapi.json")).toBe("https://api.example.com/v2.json");
  expect(keptEdit(null, "https://api.example.com/openapi.json")).toBeNull();
});

test("a save's own late refresh doesn't undo a pick made since; every other refresh is followed", () => {
  // Saved "custom", then removed it before the refresh came: the refresh doesn't put it back, and the wait ends.
  const sent = pendingAfterSave<string | null>("custom", "chat");
  expect(onRefresh(pickedSince(sent), "custom")).toEqual({ pending: null, follow: false });

  // Nothing picked since: its own refresh is followed (and ends the wait).
  expect(onRefresh(sent, "custom")).toEqual({ pending: null, follow: true });

  // A teammate's save lands first: followed, and the wait goes on for this page's own.
  expect(onRefresh(sent, "help")).toEqual({ pending: sent, follow: true });

  // A teammate removes the icon with nothing waiting: followed ("no icon" isn't "nothing waiting").
  expect(onRefresh<string | null>(null, null)).toEqual({ pending: null, follow: true });
  expect(pickedSince<string | null>(null)).toBeNull();

  // Saving other fields with the icon unchanged waits for nothing, so a teammate's change away and back is followed.
  const unchanged = pendingAfterSave<string | null>("chat", "chat");
  expect(unchanged).toBeNull();
  expect(onRefresh(unchanged, "help").follow).toBe(true);
  expect(onRefresh(unchanged, "chat").follow).toBe(true);
});

test("a teammate's refresh between a save and its own replaces the pick: the save's own, stored last, is followed", () => {
  // Saved "custom", picked "help", then a teammate's "megaphone" lands: followed, and that pick is gone.
  const teammate = onRefresh(pickedSince(pendingAfterSave<string | null>("custom", "chat")), "megaphone");
  expect(teammate).toEqual({ pending: { value: "custom", picked: false }, follow: true });
  // This page's own, stored after it, is what the picker shows.
  expect(onRefresh(teammate.pending, "custom")).toEqual({ pending: null, follow: true });
});
