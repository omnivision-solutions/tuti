import { expect, test } from "vitest";

import { threads } from "./comment-threads";

const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const items = [
  { id: "a", createdAt: at(1) },
  { id: "b", createdAt: at(2) },
  { id: "a2", createdAt: at(4), parentId: "a" },
  { id: "a1", createdAt: at(3), parentId: "a" },
  { id: "orphan", createdAt: at(5), parentId: "gone" },
];
const shape = (sort: "oldest" | "newest") => threads(items, sort).map((t) => [t.item.id, t.replies.map((r) => r.id)]);

test("replies sit under their parent, oldest first, whichever way the thread is sorted", () => {
  expect(shape("oldest")).toEqual([["a", ["a1", "a2"]], ["b", []], ["orphan", []]]);
  expect(shape("newest")).toEqual([["orphan", []], ["b", []], ["a", ["a1", "a2"]]]);
});
