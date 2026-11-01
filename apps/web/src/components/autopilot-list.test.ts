import { describe, expect, it, vi } from "vitest";

import { listApproval, nextToReview } from "./autopilot-list";

// Its server actions (the bulk Approve): not called here, and they'd need the server's settings.
vi.mock("@/server/code-changes", () => ({}));

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

describe("listApproval", () => {
  const a = { id: "a", title: "A", row: null, likely: [{ id: "a1", kind: "resolves", emails: 2 }, { id: "a2", kind: "changelog_line" }] };
  const b = { id: "b", title: "B", row: null, likely: [{ id: "b1", kind: "new_article" }] };

  it("approves each change's likely updates, the open one's as its page has them", () => {
    expect(listApproval([a, b], null)).toEqual({
      changes: [
        [
          { id: "a1", kind: "resolves", emails: 2, change: "A" },
          { id: "a2", kind: "changelog_line", change: "A" },
        ],
        [{ id: "b1", kind: "new_article", change: "B" }],
      ],
    });
    // Open with the request unticked and the line reworded.
    expect(listApproval([a, b], { id: "a", updates: [{ id: "a2", kind: "changelog_line", line: "Reworded" }] })).toEqual({
      changes: [[{ id: "a2", kind: "changelog_line", line: "Reworded", change: "A" }], [{ id: "b1", kind: "new_article", change: "B" }]],
    });
    // Open, but not picked: as the others.
    expect(listApproval([b], { id: "a", updates: [{ id: "a2", kind: "changelog_line", line: "" }] })).toEqual({ changes: [[{ id: "b1", kind: "new_article", change: "B" }]] });
  });

  it("refuses the open one's ticked progress update or changelog line left blank, as its page does, and nothing at all", () => {
    expect(listApproval([a, b], { id: "a", updates: [{ id: "a2", kind: "changelog_line", line: " " }] })).toEqual({
      error: "A ticked update on the open change has no text: write it, or untick it.",
    });
    expect(listApproval([a], { id: "a", updates: [{ id: "a3", kind: "moves_forward", comment: "" }] })).toHaveProperty("error");
    expect(listApproval([a], { id: "a", updates: [] })).toEqual({ error: "Nothing's ticked on the open change: tick its updates, or pick others." });
  });
});
