import { expect, test } from "vitest";

import { statusMoveEmails } from "./status-emails";

test("Completed always ships; Planned and In progress only moving forward; nothing else emails", () => {
  for (const from of ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "CLOSED"] as const) {
    expect(statusMoveEmails(from, "COMPLETED")).toBe("shipped");
  }
  for (const from of ["OPEN", "UNDER_REVIEW", "CLOSED"] as const) {
    expect(statusMoveEmails(from, "PLANNED")).toBe("progress");
    expect(statusMoveEmails(from, "IN_PROGRESS")).toBe("progress");
  }
  expect(statusMoveEmails("PLANNED", "IN_PROGRESS")).toBe("progress");
  // Moving back (an Undo, a reopened post), or no move at all.
  expect(statusMoveEmails("IN_PROGRESS", "PLANNED")).toBeNull();
  expect(statusMoveEmails("COMPLETED", "IN_PROGRESS")).toBeNull();
  expect(statusMoveEmails("COMPLETED", "PLANNED")).toBeNull();
  expect(statusMoveEmails("PLANNED", "PLANNED")).toBeNull();
  expect(statusMoveEmails("COMPLETED", "COMPLETED")).toBeNull();
  for (const to of ["OPEN", "UNDER_REVIEW", "CLOSED"] as const) {
    expect(statusMoveEmails("PLANNED", to)).toBeNull();
  }
});
