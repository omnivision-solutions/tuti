import { describe, expect, it, vi } from "vitest";

import { inBatches, listApproval, nextToReview } from "./autopilot-list";

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

describe("inBatches", () => {
  const approvals = Array.from({ length: 120 }, (_, i) => ({ id: `u${i}` }));

  it("approves in batches of 50 at most, adding up what went and what failed", async () => {
    const sizes: number[] = [];
    const result = await inBatches(async (batch) => {
      sizes.push(batch.length);
      return { applied: batch.length - 1, failed: [{ id: batch[0]!.id, message: "Gone" }] };
    }, approvals);
    expect(sizes).toEqual([50, 50, 20]);
    expect(result).toEqual({ applied: 117, failed: [{ id: "u0", message: "Gone" }, { id: "u50", message: "Gone" }, { id: "u100", message: "Gone" }] });
  });

  it("a batch refused counts its updates as failed, and the rest still go", async () => {
    let calls = 0;
    const result = await inBatches(async (batch) => (++calls === 1 ? { error: "Action not found" } : { applied: batch.length, failed: [] }), approvals);
    expect(calls).toBe(3);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(70);
    expect(result.failed).toHaveLength(50);
    expect(result.failed[0]).toEqual({ id: "u0", message: "Action not found" });
  });

  it("a batch that doesn't come back is said, not tried again, and the rest still go", async () => {
    let calls = 0;
    const result = await inBatches(async (batch) => {
      if (++calls === 2) {
        throw new Error("Failed to fetch");
      }
      return { applied: batch.length, failed: [] };
    }, approvals);
    expect(calls).toBe(3);
    expect(result.applied).toBe(70);
    expect(result.failed).toHaveLength(50);
    expect(result.failed[0]).toEqual({ id: "u50", message: "Couldn't tell whether these went out: check them before approving again." });
  });

  it("every batch refused is the approval refused, once", async () => {
    expect(await inBatches(async () => ({ error: "Only the project's team can use Autopilot" }), approvals)).toEqual({
      applied: 0,
      failed: [],
      error: "Only the project's team can use Autopilot",
    });
  });
});
