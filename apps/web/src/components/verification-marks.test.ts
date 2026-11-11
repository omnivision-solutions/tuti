import { schemaFor } from "@tuti/content";
import { Schema } from "@tiptap/pm/model";
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
  it.each(["", "Before the break"])("keeps exact quote offsets after a hard break following %s", (prefix) => {
    const quote = "Each plan has 5 seats";
    const content = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [
      ...(prefix ? [{ type: "text", text: prefix }] : []),
      { type: "hardBreak" },
      { type: "text", text: "Each plan has " },
      { type: "text", text: "5 seats", marks: [{ type: "bold" }] },
    ] }] });
    const ranges = verificationRanges(content, [{ statement: quote, verdict: "outdated" }]);
    const from = 1 + prefix.length + 1;
    expect(ranges).toEqual([{ from, to: from + quote.length, number: 1, verdict: "outdated" }]);
    expect(content.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe(quote);
  });
  it("maps non-text inline leaves with textContent without shifting a quote or producing NaN", () => {
    const withLabel = new Schema({
      nodes: schema.spec.nodes.addBefore("text", "inlineLabel", { inline: true, group: "inline", atom: true, leafText: () => "Context. " }),
      marks: schema.spec.marks,
    });
    const quote = "Each plan has 5 seats";
    const content = withLabel.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "inlineLabel" }, { type: "text", text: quote },
    ] }] });
    expect(verificationRanges(content, [{ statement: quote, verdict: "outdated" }])).toEqual([
      { from: 2, to: 2 + quote.length, number: 1, verdict: "outdated" },
    ]);
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
    ["Published記事", "Unpublished記事"],
    ["席数5", "席数50"],
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
  it.each([
    ["設定から", "記事を公開", "できます。"],
    ["𠮷", "𠮷野", "家。"],
    ["您可以在设置中", "发布文章", "并查看。"],
    ["คุณสามารถ", "เผยแพร่บทความ", "จากการตั้งค่า"],
  ])("underlines a partial quote in spaceless text after %s", (prefix, quote, suffix) => {
    const content = schema.nodeFromJSON({
      type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: `🗓 ${prefix}` },
        { type: "text", text: quote, marks: [{ type: "bold" }] },
        { type: "text", text: suffix },
      ] }],
    });
    const from = 1 + `🗓 ${prefix}`.length;
    const ranges = verificationRanges(content, [{ statement: quote, verdict: "outdated" }]);
    expect(ranges).toEqual([{ from, to: from + quote.length, number: 1, verdict: "outdated" }]);
    expect(content.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe(quote);
  });
  it.each([
    ["公開の記事は", "非公開の記事は。", "", ""],
    ["公開の記事は", "非公開の記事は。", "詳しくは「", "」をご覧ください。"],
    ["发布的文章", "未发布的文章。", "参照 ", " 一覧"],
  ])("underlines the bounded quote instead of an earlier prefixed clause: %s", (quote, other, prefix, suffix) => {
    const content = schema.nodeFromJSON({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: other }] },
      { type: "paragraph", content: [
        { type: "text", text: `🗓 ${prefix}${quote.slice(0, 1)}` },
        { type: "text", text: quote.slice(1), marks: [{ type: "bold" }] },
        ...(suffix ? [{ type: "text", text: suffix }] : []),
      ] },
    ] });
    const from = other.length + 3 + `🗓 ${prefix}`.length;
    expect(verificationRanges(content, [{ statement: quote, verdict: "outdated" }])).toEqual([
      { from, to: from + quote.length, number: 1, verdict: "outdated" },
    ]);
  });
  it("prefers bounded spaceless text even when a quote adds whitespace", () => {
    const content = schema.nodeFromJSON({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "非公開の記事は。" }] },
      { type: "paragraph", content: [{ type: "text", text: "公開の記事は" }] },
    ] });
    const from = "非公開の記事は。".length + 3;
    expect(verificationRanges(content, [{ statement: "公開 の記事は", verdict: "outdated" }])).toEqual([
      { from, to: from + "公開の記事は".length, number: 1, verdict: "outdated" },
    ]);
  });
});
