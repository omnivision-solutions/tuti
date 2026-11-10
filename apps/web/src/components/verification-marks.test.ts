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
  it("does not underline the fix in place of the checked sentence", () => {
    expect(
      verificationRanges(doc("Each plan has 10 seats. You pay monthly."), [
        ...findings,
      ]),
    ).toEqual([{ from: 25, to: 40, number: 2, verdict: "unclear" }]);
  });
});
