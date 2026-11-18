import { expect, test } from "vitest";

import { costLabel, costPerUse } from "./model-tiers";

const listed = [
  { id: "anthropic/claude-haiku-5.5", name: "Haiku", input: 1e-6, output: 5e-6, tools: true },
  { id: "anthropic/claude-sonnet-5.5", name: "Sonnet", input: 3e-6, output: 15e-6, tools: true },
  { id: "anthropic/claude-opus-5.5", name: "Opus", input: 15e-6, output: 75e-6, tools: true },
];

test("what one use costs, in dollars or credits", () => {
  // 6,000 tokens read at $3 and 500 written at $15 per million: $0.0255.
  const answer = costPerUse("answers", listed[1]);
  expect(answer).toEqual({ dollars: 6000 * 3e-6 + 500 * 15e-6, per: "answer" });
  expect(costLabel(answer, null)).toBe("About $0.026 per answer");
  expect(costLabel(answer, 100)).toBe("About 2.6 credits per answer");
  // Autopilot's steps, each its own: deciding on Haiku, 150,000 read and 4,000 written at $1 and $5 per million ($0.17);
  // writing on Sonnet, 60,000 and 5,000 at $3 and $15 ($0.255); the double-check only when it runs.
  expect(costLabel(costPerUse("code_changes_decide", listed[0]), null)).toBe("About $0.17 per merged pull request");
  expect(costLabel(costPerUse("code_changes", listed[1]), null)).toBe("About $0.26 per merged pull request");
  expect(costLabel(costPerUse("code_changes_check", listed[1]), null)).toBe("About $0.51 per double-check of a new article");
  // Checks' review of one edit, where the server checks them: 70,000 read and 3,000 written on Sonnet ($0.255).
  expect(costLabel(costPerUse("edit_review", listed[1]), 100)).toBe("About 26 credits per edit reviewed");
  expect(costPerUse("answers", { id: "x", name: "x", input: null, output: null, tools: true })).toBeNull();
  expect(costLabel(null, null)).toBeNull();
});
