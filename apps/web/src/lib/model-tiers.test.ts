import { expect, test } from "vitest";

import { choiceOf, costLabel, costPerUse, pickedModel, tiersFor } from "./model-tiers";

const listed = [
  { id: "anthropic/claude-haiku-5.5", name: "Haiku", input: 1e-6, output: 5e-6 },
  { id: "anthropic/claude-sonnet-5.5", name: "Sonnet", input: 3e-6, output: 15e-6 },
  { id: "anthropic/claude-opus-5.5", name: "Opus", input: 15e-6, output: 75e-6 },
];

test("Fast is the feature's default; Balanced and Best where the endpoint lists them", () => {
  expect(tiersFor("anthropic/claude-haiku-5.5", listed).map((t) => t.tier)).toEqual(["fast", "balanced", "best"]);
  expect(tiersFor("anthropic/claude-haiku-5.5", listed.slice(0, 2)).map((t) => t.tier)).toEqual(["fast", "balanced"]);
  // A default that is a tier's model isn't offered twice.
  expect(tiersFor("anthropic/claude-sonnet-5.5", listed).map((t) => t.tier)).toEqual(["fast", "best"]);
  expect(tiersFor("anthropic/claude-haiku-5.5", []).map((t) => t.tier)).toEqual(["fast"]);
});

test("a saved pick is Fast when there's none, its tier when it's a tier's model, else Custom", () => {
  const tiers = tiersFor("anthropic/claude-haiku-5.5", listed);
  expect(choiceOf(null, tiers)).toBe("fast");
  expect(choiceOf("anthropic/claude-opus-5.5", tiers)).toBe("best");
  expect(choiceOf("acme/imaginary", tiers)).toBe("custom");
});

test("what one use costs, in dollars or credits", () => {
  // 6,000 tokens read at $3 and 500 written at $15 per million: $0.0255.
  const answer = costPerUse("answers", listed[1]);
  expect(answer).toEqual({ dollars: 6000 * 3e-6 + 500 * 15e-6, per: "answer" });
  expect(costLabel(answer, null)).toBe("About $0.026 per answer");
  expect(costLabel(answer, 100)).toBe("About 2.6 credits per answer");
  // A merged pull request: the docs agent's deciding (on Haiku here), and the picked model's writing with the tools (Sonnet).
  // 150,000 read and 4,000 written at $1 and $5, then 60,000 and 5,000 at $3 and $15 per million: $0.425, about $0.42.
  expect(costLabel(costPerUse("code_changes", listed[1], listed[0]), null)).toBe("About $0.42 per merged pull request (the docs agent deciding, and writing)");
  // Its deciding model not listed (no price): no estimate rather than a wrong one.
  expect(costPerUse("code_changes", listed[1], null)).toBeNull();
  expect(costPerUse("code_changes", listed[1])).toBeNull();
  expect(costPerUse("answers", { id: "x", name: "x", input: null, output: null })).toBeNull();
  expect(costLabel(null, null)).toBeNull();
});

test("what a choice saves; a tier the endpoint stopped listing keeps the saved model", () => {
  const tiers = tiersFor("anthropic/claude-haiku-5.5", listed);
  expect(pickedModel("fast", "", tiers, "anthropic/claude-opus-5.5")).toBe("");
  expect(pickedModel("best", "", tiers, null)).toBe("anthropic/claude-opus-5.5");
  expect(pickedModel("custom", "acme/tiny", tiers, null)).toBe("acme/tiny");
  const withoutBest = tiersFor("anthropic/claude-haiku-5.5", listed.slice(0, 2));
  expect(pickedModel("best", "", withoutBest, "anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
});
