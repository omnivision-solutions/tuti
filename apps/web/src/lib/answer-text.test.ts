import { expect, test } from "vitest";

import { answerBlocks } from "./answer-text";

test("paragraphs, bullet and numbered lists; markup stays text", () => {
  const answer = [
    "Owners and admins can invite people.",
    "They do it from **Settings**.",
    "",
    "- Open `Team`",
    "- Click Invite",
    "1. Enter an email",
    "2) Send",
    "",
    "- After a blank line",
    "## Not a heading",
    '<img src=x onerror="alert(1)">',
  ].join("\n");
  expect(answerBlocks(answer)).toEqual([
    { type: "paragraph", text: "Owners and admins can invite people. They do it from Settings." },
    { type: "list", ordered: false, items: ["Open Team", "Click Invite"] },
    { type: "list", ordered: true, items: ["Enter an email", "Send"] },
    { type: "list", ordered: false, items: ["After a blank line"] },
    { type: "paragraph", text: 'Not a heading <img src=x onerror="alert(1)">' },
  ]);
});

test("nothing but blank lines is nothing", () => {
  expect(answerBlocks("\n \n")).toEqual([]);
});
