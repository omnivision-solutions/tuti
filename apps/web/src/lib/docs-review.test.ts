import { describe, expect, it } from "vitest";
import { changedParagraphs, fixSummary, markedRun, matchingSentence } from "./docs-review";

describe("Docs review summaries", () => {
  it("counts a replacement as one paragraph, includes insertions and removals, and ignores unchanged content", () => {
    expect(changedParagraphs([{ kind: "removed" }, { kind: "added" }])).toBe(1);
    expect(changedParagraphs([{ kind: "removed" }, { kind: "removed" }, { kind: "added" }, { kind: "same" }, { kind: "added" }])).toBe(3);
    expect(changedParagraphs([{ kind: "same" }])).toBe(0);
  });
  it("summarises the changed words with enough context to understand the fix", () => {
    expect(fixSummary("Each plan includes 5 seats.", "Each plan includes 10 seats.")).toBe('“5 seats” becomes “10 seats”');
    expect(fixSummary("Same.", "Same.")).toBeNull();
    expect(fixSummary("", "A new paragraph.")).toContain("A new paragraph");
  });
  it("finds a quoted source inside paragraphs with other quantities or number words", () => {
    expect(matchingSentence("Each plan has 5 seats.", ["Each plan has 5 seats. You can add up to 10 more from Billing."])).toBe(0);
    expect(matchingSentence("People are admins or members.", ["People are admins or members. Pick one role."])).toBe(0);
    expect(matchingSentence("Pick one role.", ["Pick one role. Invite up to 10 people."])).toBe(0);
  });
  it("finds a paraphrased claim but refuses a changed quantity or an ambiguous match", () => {
    expect(matchingSentence("Each plan has 5 seats", ["Each plan has 5 seats. You can add 10 more."])).toBe(0);
    expect(matchingSentence("Each plan has 5 seats", ["Each plan has 10 seats. Add 5 more."])).toBe(-1);
    expect(matchingSentence("Each plan has 5 seats", ["Each plan has 5 seats.", "Each plan has 5 seats."])).toBe(0);
    expect(matchingSentence("Exporting calendars includes five seats", ["Export calendars with 5 seats."])).toBe(0);
    const blocks = ["Every plan includes 5 seats for your team.", "Billing is monthly."];
    expect(matchingSentence("Your team gets 5 seats with every plan.", blocks)).toBe(0);
    expect(matchingSentence("Your team gets 10 seats with every plan.", blocks)).toBe(-1);
    expect(matchingSentence("Your team gets 5 seats with every plan.", [blocks[0]!, blocks[0]!])).toBe(-1);
    expect(matchingSentence("You can export a calendar.", blocks)).toBe(-1);
  });
  it("marks the newest run that checked statements, not a newer skipped, running or failed one", () => {
    const done = { id: "1", state: "done", statements: [{}] };
    expect(markedRun([{ id: "3", state: "running", statements: [] }, { id: "2", state: "skipped", statements: [] }, done])?.id).toBe("1");
    expect(markedRun([{ id: "2", state: "changed", statements: [] }, done])?.id).toBe("1");
    expect(markedRun([{ id: "2", state: "failed", statements: [] }])).toBeUndefined();
    // A newer finished check that found nothing replaces the older findings: nothing is marked.
    expect(markedRun([{ id: "2", state: "done", statements: [] }, done])?.id).toBe("2");
  });
});
