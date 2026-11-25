import { describe, expect, it } from "vitest";

import { snoozeChoices, standing, type Triage } from "./details";

const at = (local: string) => new Date(local);

describe("snoozing", () => {
  it("offers the web's choices: 3 hours on, tomorrow at 9:00, and the next Monday at 9:00 (a week on from a Monday)", () => {
    const wednesday = at("2026-11-25T14:00:00");
    expect(snoozeChoices(wednesday).map((choice) => [choice.label, choice.at.getTime()])).toEqual([
      ["In 3 hours", at("2026-11-25T17:00:00").getTime()],
      ["Tomorrow, 9:00", at("2026-11-26T09:00:00").getTime()],
      ["Monday, 9:00", at("2026-11-30T09:00:00").getTime()],
    ]);
    expect(snoozeChoices(at("2026-11-30T08:00:00"))[2]!.at).toEqual(at("2026-12-07T09:00:00"));
    expect(snoozeChoices(at("2026-11-29T20:00:00"))[2]!.at).toEqual(at("2026-11-30T09:00:00"));
  });
});

describe("the header's word", () => {
  const open: Triage = { status: "open", assignee: null, spam: false, snoozedUntil: null };
  const now = Date.parse("2026-11-25T14:00:00Z");
  it("says spam, then a snooze still to end, then the status", () => {
    expect(standing(open, now)).toBe("Open");
    expect(standing({ ...open, status: "waiting" }, now)).toBe("Waiting");
    expect(standing({ ...open, snoozedUntil: "2026-11-26T09:00:00Z" }, now)).toBe("Snoozed");
    expect(standing({ ...open, snoozedUntil: "2026-11-25T09:00:00Z" }, now)).toBe("Open");
    expect(standing({ ...open, status: "closed", snoozedUntil: "2026-11-26T09:00:00Z" }, now)).toBe("Closed");
    expect(standing({ ...open, spam: true }, now)).toBe("Spam");
  });
});
