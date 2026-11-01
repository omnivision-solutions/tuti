import { describe, expect, it } from "vitest";

import { nextToReview } from "./autopilot-list";

describe("nextToReview", () => {
  it("opens the next change still to review once the open one is reviewed", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
  });

  it("goes back to the first when the reviewed one was the last", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "b"], "c")).toBe("a");
  });

  it("stays when nothing is left to review", () => {
    expect(nextToReview(["a"], [], "a")).toBeNull();
  });

  it("stays while the open one is still to review, or wasn't (a reviewed change opened from the list)", () => {
    expect(nextToReview(["a", "b"], ["a", "b"], "a")).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], "z")).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], null)).toBeNull();
  });
});
