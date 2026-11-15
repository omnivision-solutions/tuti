import { describe, expect, it } from "vitest";

import { statusPrompt } from "./status-prompt";

describe("statusPrompt", () => {
  it("asks before a move that emails, naming how many", () => {
    expect(statusPrompt("OPEN", "COMPLETED", 1)).toBe("This emails up to 1 person who asked for it that it shipped.");
    expect(statusPrompt("OPEN", "PLANNED", 3)).toBe("This emails up to 3 people who asked for it that it's planned.");
    expect(statusPrompt("PLANNED", "IN_PROGRESS", 2)).toBe("This emails up to 2 people who asked for it that it's in progress.");
  });

  it("asks before Completed even when it emails nobody; Planned and In progress then go without asking", () => {
    expect(statusPrompt("IN_PROGRESS", "COMPLETED", 0)).toBe("Nobody is emailed.");
    expect(statusPrompt("OPEN", "PLANNED", 0)).toBeNull();
    expect(statusPrompt("OPEN", "IN_PROGRESS", 0)).toBeNull();
  });

  it("never asks before a move that emails nobody: backward, Open, Under review, Closed, or no change", () => {
    expect(statusPrompt("IN_PROGRESS", "PLANNED", 5)).toBeNull();
    expect(statusPrompt("COMPLETED", "IN_PROGRESS", 5)).toBeNull();
    expect(statusPrompt("PLANNED", "OPEN", 5)).toBeNull();
    expect(statusPrompt("OPEN", "UNDER_REVIEW", 5)).toBeNull();
    expect(statusPrompt("PLANNED", "CLOSED", 5)).toBeNull();
    expect(statusPrompt("COMPLETED", "COMPLETED", 5)).toBeNull();
  });
});
