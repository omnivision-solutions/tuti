import { describe, expect, it } from "vitest";

import { nextToReview } from "./autopilot-list";

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
