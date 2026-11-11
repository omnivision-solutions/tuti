import { describe, expect, it } from "vitest";
import { changedParagraphs, fixSummary, matchingSentence } from "./docs-review";

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
  it("finds a paraphrased claim but refuses a changed quantity or an ambiguous match", () => {
    expect(matchingSentence("Each plan has 5 seats", ["Each plan has 5 seats. You can add 10 more."])).toBe(0);
    expect(matchingSentence("Each plan has 5 seats", ["Each plan has 5 seats.", "Each plan has 5 seats."])).toBe(0);
    expect(matchingSentence("Exporting calendars includes five seats", ["Export calendars with 5 seats, or add 10 more."])).toBe(0);
    const blocks = ["Every plan includes 5 seats for your team.", "Billing is monthly."];
    expect(matchingSentence("Your team gets 5 seats with every plan.", blocks)).toBe(0);
    expect(matchingSentence("Your team gets 10 seats with every plan.", blocks)).toBe(-1);
    expect(matchingSentence("Your team gets 5 seats with every plan.", [blocks[0]!, blocks[0]!])).toBe(-1);
    expect(matchingSentence("You can export a calendar.", blocks)).toBe(-1);
  });
});
