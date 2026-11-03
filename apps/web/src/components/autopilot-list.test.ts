import { describe, expect, it } from "vitest";

import { nextToReview, treeOrder } from "./autopilot-list";

describe("nextToReview", () => {
  it("opens the next change still to review once the open one's updates are decided", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "c"], "b", "b")).toBe("c");
  });

  it("goes back to the first when the reviewed one was the last", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "b"], "c", "c")).toBe("a");
  });

  it("stays when nothing is left to review", () => {
    expect(nextToReview(["a"], [], "a", "a")).toBeNull();
  });

  it("stays while the open one is still to review, or wasn't (a reviewed change opened from the list)", () => {
    expect(nextToReview(["a", "b"], ["a", "b"], "a", "a")).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], "z", "z")).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], null, null)).toBeNull();
  });

  it("stays when the open one left To review without the team deciding it (analysed again, written again, resumed): its page says how it went", () => {
    expect(nextToReview(["a", "b"], ["b"], "a", null)).toBeNull();
  });
});

describe("treeOrder", () => {
  // The most reached first: P1 (Bugs), P2 (Ideas), P3 (Bugs), an article in no collection, then one in Billing.
  const rows = [
    { id: "p1", section: "Feedback", group: { id: "bugs" } },
    { id: "p2", section: "Feedback", group: { id: "ideas" } },
    { id: "p3", section: "Feedback", group: { id: "bugs" } },
    { id: "a1", section: "Help center", group: null },
    { id: "a2", section: "Help center", group: { id: "billing" } },
  ];

  it("lists each board's or collection's rows together, in the order of their first, then those in none", () => {
    expect(treeOrder(rows).map((row) => row.id)).toEqual(["p1", "p3", "p2", "a2", "a1"]);
  });

  it("opens the row under the one decided, as the tree shows them", () => {
    const before = treeOrder(rows).map((row) => row.id);
    const after = treeOrder(rows.filter((row) => row.id !== "p1")).map((row) => row.id);
    expect(nextToReview(before, after, "p1", "p1")).toBe("p3");
  });
});
