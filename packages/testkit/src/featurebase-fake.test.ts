import { afterEach, expect, test, vi } from "vitest";

import { featurebaseFixtures } from "./featurebase-fake";

afterEach(() => {
  vi.restoreAllMocks();
});

test("the conversations' dates are minutes apart exactly, however the clock moves while they're made", () => {
  // A millisecond on with every read of the clock, as on a busy machine.
  let now = Date.UTC(2026, 10, 20);
  vi.spyOn(Date, "now").mockImplementation(() => now++);
  const snoozed = featurebaseFixtures().conversations.find((c) => c.id === "1003")!;
  const parts = snoozed.conversationParts as { id: string; createdAt: string }[];
  const at = (id: string) => Date.parse(parts.find((p) => p.id === id)!.createdAt);
  expect(at("p2003") - at("p2002")).toBe(60_000);
  expect(Date.parse(snoozed.updatedAt as string)).toBe(at("p2003"));
});
