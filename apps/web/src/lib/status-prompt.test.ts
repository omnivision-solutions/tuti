import { describe, expect, it } from "vitest";

import { statusPrompt } from "./status-prompt";

describe("statusPrompt", () => {
  it("asks before a move that emails, naming how many", () => {
    expect(statusPrompt("OPEN", "COMPLETED", { COMPLETED: 1 })).toBe("This emails up to 1 person who asked for it that it shipped.");
    expect(statusPrompt("OPEN", "PLANNED", { PLANNED: 3 })).toBe("This emails up to 3 people who asked for it that it's planned.");
    expect(statusPrompt("PLANNED", "IN_PROGRESS", { IN_PROGRESS: 2 })).toBe("This emails up to 2 people who asked for it that it's in progress.");
  });

  it("asks before Completed even when it emails nobody; Planned and In progress then go without asking", () => {
    expect(statusPrompt("IN_PROGRESS", "COMPLETED", { COMPLETED: 0 })).toBe("Nobody is emailed.");
    expect(statusPrompt("OPEN", "PLANNED", { PLANNED: 0 })).toBeNull();
    expect(statusPrompt("OPEN", "IN_PROGRESS", { IN_PROGRESS: 0 })).toBeNull();
    // Each move by its own count: those already told it's planned aren't again.
    expect(statusPrompt("OPEN", "PLANNED", { PLANNED: 0, COMPLETED: 2 })).toBeNull();
  });

  it("never asks before a move that emails nobody: backward, Open, Under review, Closed, or no change", () => {
    expect(statusPrompt("IN_PROGRESS", "PLANNED", { PLANNED: 5 })).toBeNull();
    expect(statusPrompt("COMPLETED", "IN_PROGRESS", { IN_PROGRESS: 5 })).toBeNull();
    expect(statusPrompt("PLANNED", "OPEN", { OPEN: 5 })).toBeNull();
    expect(statusPrompt("OPEN", "UNDER_REVIEW", { UNDER_REVIEW: 5 })).toBeNull();
    expect(statusPrompt("PLANNED", "CLOSED", { CLOSED: 5 })).toBeNull();
    expect(statusPrompt("COMPLETED", "COMPLETED", { COMPLETED: 5 })).toBeNull();
  });
});
