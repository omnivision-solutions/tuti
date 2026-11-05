import { expect, test } from "vitest";

import { IMPORT_PARTS, importSummary, kindCount, missingNeed, onHome, pickPart } from "./import-parts";

// The parts as the plan has them, Feedback and Inbox needing Contacts (only Contacts is built so far).
const parts = { contacts: { needs: [] }, feedback: { needs: ["contacts"] }, docs: { needs: [] }, inbox: { needs: ["contacts"] } };

test("ticking a part ticks what it needs; unticking one unticks what needs it", () => {
  expect(pickPart([], "feedback", true, parts)).toEqual(["contacts", "feedback"]);
  expect(pickPart(["docs"], "inbox", true, parts)).toEqual(["contacts", "docs", "inbox"]);
  expect(pickPart(["contacts", "feedback", "docs", "inbox"], "contacts", false, parts)).toEqual(["docs"]);
  expect(pickPart(["contacts", "feedback", "inbox"], "feedback", false, parts)).toEqual(["contacts", "inbox"]);
  expect(pickPart(["contacts"], "docs", true, parts)).toEqual(["contacts", "docs"]);
});

test("a picked part without what it needs is named", () => {
  expect(missingNeed(["feedback"], parts)).toEqual({ part: "feedback", need: "contacts" });
  expect(missingNeed(["contacts", "feedback", "inbox"], parts)).toBeNull();
  expect(missingNeed(["contacts"], IMPORT_PARTS)).toBeNull();
});

test("counts in words", () => {
  expect(kindCount("contacts", 1)).toBe("1 contact");
  expect(kindCount("contacts", 1200)).toBe("1,200 contacts");
});

test("an import's summary: what came across, what was left out and why, and why it stopped", () => {
  const run = { state: "done", counts: { contacts: { imported: 3, leftOut: {} } }, error: null } as never;
  expect(importSummary(run)).toBe("3 contacts brought across.");
  expect(importSummary({ state: "running", counts: {}, error: null } as never)).toBe("Starting…");
  expect(importSummary({ state: "failed", counts: { contacts: { imported: 1, leftOut: { "without a name": 2 } } }, error: "Featurebase couldn't be reached." } as never)).toBe(
    "1 contact brought across. Left out: 2 contacts without a name. Featurebase couldn't be reached.",
  );
});

test("Home shows an import while it runs and for three days after it ended", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(onHome({ state: "running", finishedAt: null } as never, now)).toBe(true);
  expect(onHome({ state: "done", finishedAt: "2026-11-03T12:00:00Z" } as never, now)).toBe(true);
  expect(onHome({ state: "failed", finishedAt: "2026-11-02T11:00:00Z" } as never, now)).toBe(false);
});
