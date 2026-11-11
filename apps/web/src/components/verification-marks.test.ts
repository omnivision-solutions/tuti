import { schemaFor } from "@tuti/content";
import { describe, expect, it } from "vitest";
import { verificationRanges } from "./verification-marks";

const schema = schemaFor("article");
const doc = (text: string) =>
  schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
describe("verification annotations", () => {
  const findings = [
    { statement: "Each plan has 5 seats.", verdict: "outdated" },
    { statement: "People are admins", verdict: "current" },
    { statement: "You pay monthly", verdict: "unclear" },
  ] as const;
  it("numbers only flagged claims and matches across formatting", () => {
    const content = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Each plan has " },
            { type: "text", text: "5 seats.", marks: [{ type: "bold" }] },
            { type: "text", text: " You pay monthly." },
          ],
        },
      ],
    });
    expect(verificationRanges(content, [...findings])).toEqual([
      { from: 1, to: 22, number: 1, verdict: "outdated" },
      { from: 24, to: 39, number: 2, verdict: "unclear" },
    ]);
  });
  it("keeps document positions after a symbol outside the basic multilingual plane", () => {
    expect(
      verificationRanges(doc("🗓 Each plan has 5 seats."), [...findings]),
    ).toEqual([{ from: 4, to: 25, number: 1, verdict: "outdated" }]);
  });
  it("annotates a paraphrased finding without changing its number or verdict", () => {
    expect(verificationRanges(doc("Every plan includes 5 seats for your team."), [{ statement: "Your team gets 5 seats with every plan", verdict: "outdated" }])).toMatchObject([{ from: 1, number: 1, verdict: "outdated" }]);
  });
  it("uses a quoted source when the finding paraphrases it beyond word matching", () => {
    expect(verificationRanges(doc("Team admins can invite five people."), [{ statement: "Invitations are restricted", source: "Team admins can invite five people.", verdict: "outdated" }])).toMatchObject([{ from: 1, number: 1 }]);
  });
  it("does not underline the fix in place of the checked sentence", () => {
    expect(
      verificationRanges(doc("Each plan has 10 seats. You pay monthly."), [
        ...findings,
      ]),
    ).toEqual([{ from: 25, to: 40, number: 2, verdict: "unclear" }]);
  });
  it.each([
    ["Published articles are visible.", "Unpublished articles are visible."],
    ["Seat limit: 5", "Seat limit: 50"],
  ])("requires whole words and quantities when underlining %s", (source, other) => {
    const content = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: other }] },
        { type: "paragraph", content: [
          { type: "text", text: "🗓 Check: " },
          { type: "text", text: source, marks: [{ type: "bold" }] },
          { type: "text", text: " Ask support." },
        ] },
      ],
    });
    const ranges = verificationRanges(content, [{ statement: source, verdict: "outdated" }]);
    const from = other.length + 3 + "🗓 Check: ".length;
    expect(ranges).toEqual([{ from, to: from + source.replace(/\.$/, "").length, number: 1, verdict: "outdated" }]);
    expect(content.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe(source.replace(/\.$/, ""));
    expect(verificationRanges(doc(other), [{ statement: source, verdict: "outdated" }])).toEqual([]);
  });
  it("keeps underline offsets through invisible characters, whitespace and formatting", () => {
    const content = schema.nodeFromJSON({
      type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "🗓 Pick o" },
        { type: "text", text: "\u200bne", marks: [{ type: "bold" }] },
        { type: "text", text: "\trole. Ask support." },
      ] }],
    });
    const quoted = "Pick o\u200bne\trole";
    const ranges = verificationRanges(content, [{ statement: "Pick one role", verdict: "unclear" }]);
    expect(ranges).toEqual([{ from: 4, to: 4 + quoted.length, number: 1, verdict: "unclear" }]);
    expect(content.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe(quoted);
  });
});
