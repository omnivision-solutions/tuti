import { expect, test } from "vitest";

import { laterSeen, unreadNumbers } from "./whats-new";

test("the later of two times seen counts; never seen is earlier than any", () => {
  expect(laterSeen(null, null)).toBeNull();
  expect(laterSeen("2026-10-18T10:00:00.000Z", null)).toBe("2026-10-18T10:00:00.000Z");
  expect(laterSeen(null, "2026-10-18T10:00:00.000Z")).toBe("2026-10-18T10:00:00.000Z");
  expect(laterSeen("2026-10-19T00:00:00.000Z", "2026-10-18T10:00:00.000Z")).toBe("2026-10-19T00:00:00.000Z");
  expect(laterSeen("2026-10-18T10:00:00.000Z", "2026-10-19T00:00:00.000Z")).toBe("2026-10-19T00:00:00.000Z");
});

test("unread: published after the time seen (one published at that moment was seen)", () => {
  const fresh = [
    { number: 3, at: "2026-10-19T00:00:00.000Z" },
    { number: 2, at: "2026-10-18T10:00:00.000Z" },
  ];
  expect(unreadNumbers(fresh, null)).toEqual([3, 2]);
  expect(unreadNumbers(fresh, "2026-10-18T10:00:00.000Z")).toEqual([3]);
  expect(unreadNumbers(fresh, "2026-10-19T00:00:00.000Z")).toEqual([]);
});
