import { describe, expect, it } from "vitest";

import { nextToReview } from "./autopilot-list";

describe("nextToReview", () => {
  it("opens the next change still to review once the open one's updates are decided", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "c"], "b", ["a", "b", "c"])).toBe("c");
  });

  it("goes back to the first when the reviewed one was the last", () => {
    expect(nextToReview(["a", "b", "c"], ["a", "b"], "c", ["c"])).toBe("a");
  });

  it("stays when nothing is left to review", () => {
    expect(nextToReview(["a"], [], "a", ["a"])).toBeNull();
  });

  it("stays while the open one is still to review, or wasn't (a reviewed change opened from the list)", () => {
    expect(nextToReview(["a", "b"], ["a", "b"], "a", ["a", "b"])).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], "z", ["a", "b"])).toBeNull();
    expect(nextToReview(["a", "b"], ["b"], null, ["a", "b"])).toBeNull();
  });

  it("stays when the open one left To review without updates waiting (analysed again, or resumed): its page says how it went", () => {
    expect(nextToReview(["a", "b"], ["b"], "a", ["b"])).toBeNull();
  });
});
