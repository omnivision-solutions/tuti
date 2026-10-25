import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { aiEnabled, complete, decide, DEFAULT_AI_MODEL, DEFAULT_DECISION_MODEL, defaultModel, listModels, modelMaxPrice, withinModelCap } from "./ai";
import type { AiUsage } from "./usage";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

/** Usage goes nowhere, except in the tests about it. */
const meter = async () => {};
const ai = { model: "acme/writer", meter };

const useFake = () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
};

test("AI is off without an OpenRouter key", async () => {
  expect(aiEnabled()).toBe(false);
  await expect(complete({ system: "s", user: "u", ...ai })).rejects.toThrow("OPENROUTER_API_KEY is not set");
});

test("sends the system and user messages to the model it's given, with the token cap, and returns the reply", async () => {
  useFake();
  expect(aiEnabled()).toBe(true);
  model.reply("Hello");
  expect(await complete({ system: "Be brief", user: "Hi", ...ai })).toBe("Hello");
  model.reply("Again");
  expect(await complete({ system: "Be brief", user: "Hi again", maxTokens: 300, model: "acme/tiny", meter })).toBe("Again");
  expect(model.requests).toEqual([
    { model: "acme/writer", system: "Be brief", user: "Hi", maxTokens: 4000 },
    { model: "acme/tiny", system: "Be brief", user: "Hi again", maxTokens: 300 },
  ]);
});

test("each feature's default model: its own setting, else AI_MODEL, else Tuti's", () => {
  expect(defaultModel("answers")).toBe(DEFAULT_AI_MODEL);
  vi.stubEnv("AI_MODEL", "acme/everything");
  vi.stubEnv("AI_MODEL_CODE_CHANGES", "acme/careful");
  expect([defaultModel("answers"), defaultModel("escalations"), defaultModel("changelog"), defaultModel("code_changes")]).toEqual([
    "acme/everything",
    "acme/everything",
    "acme/everything",
    "acme/careful",
  ]);
  // Empty is unset.
  vi.stubEnv("AI_MODEL_CODE_CHANGES", "");
  expect(defaultModel("code_changes")).toBe("acme/everything");
});

test("lists the endpoint's models, with their prices per token", async () => {
  await expect(listModels()).rejects.toThrow("OPENROUTER_API_KEY is not set");
  useFake();
  const models = await listModels();
  expect(models).toContainEqual({ id: DEFAULT_AI_MODEL, name: expect.any(String) as string, input: 1e-6, output: 5e-6 });
  expect(models.map((listed) => listed.id)).toContain("acme/no-price");
  expect(models.find((listed) => listed.id === "acme/no-price")).toMatchObject({ input: null, output: null });
});

test("the cap on the models projects pick: none unless AI_MODEL_MAX_PRICE is a positive price; under one, only models priced at or under it", () => {
  const priced = (output: number | null) => ({ id: "acme/model", name: "Acme: Model", input: 0, output });
  expect(modelMaxPrice()).toBeNull();
  expect(withinModelCap(priced(null))).toBe(true);
  for (const value of ["", "0", "-1", "lots"]) {
    vi.stubEnv("AI_MODEL_MAX_PRICE", value);
    expect(modelMaxPrice()).toBeNull();
  }

  vi.stubEnv("AI_MODEL_MAX_PRICE", "0.4");
  expect(modelMaxPrice()).toBe(0.4);
  // OpenRouter's "0.0000004" per token is exactly the cap, though not exactly 0.4 / 1e6 in floating point.
  expect(withinModelCap(priced(Number("0.0000004")))).toBe(true);
  expect(withinModelCap(priced(Number("0.00000041")))).toBe(false);
  expect(withinModelCap(priced(0))).toBe(true);
  // Without a price it can't be checked.
  expect(withinModelCap(priced(null))).toBe(false);
});

test("a failed request or an empty reply throws", async () => {
  useFake();
  model.fail(429);
  await expect(complete({ system: "s", user: "u", ...ai })).rejects.toThrow("AI request failed (429): fake failure");
  model.reply("  ");
  await expect(complete({ system: "s", user: "u", ...ai })).rejects.toThrow("The AI reply had no text");
});

test("the model fake keeps a reply with a match for the request that contains it", async () => {
  useFake();
  model.reply("For the question", undefined, "How do I invite?");
  model.reply("For anything");
  expect(await complete({ system: "s", user: "Draft the notes", ...ai })).toBe("For anything");
  expect(await complete({ system: "s", user: "Question: How do I invite?", ...ai })).toBe("For the question");
});

test("decisions go to the decision model, with the data policy, and come back as probabilities", async () => {
  useFake();
  vi.stubEnv("DECISION_MODEL", "test/decider");
  model.decide({ shipped: 0.8, area: { ui: 0.7, api: 0.3 } });
  const answers = await decide(
    { pull_request: "Dark mode" },
    {
      shipped: { type: "noul", instructions: "Did it ship?", criteria: { true: "Yes", false: "No" } },
      area: { type: "choice", instructions: "Which area?", criteria: { ui: "The interface", api: "The API" } },
    },
    { meter },
  );
  expect(answers).toEqual({ shipped: { type: "noul", noul: 0.8 }, area: { type: "choice", choice: "ui", probabilities: { ui: 0.7, api: 0.3 } } });
  expect(model.decisions).toEqual([
    expect.objectContaining({ model: "test/decider", state: { pull_request: "Dark mode" }, provider: { data_collection: "deny" } }),
  ]);
});

test("the decision model has a default; a question left unanswered is an error", async () => {
  useFake();
  const question = { shipped: { type: "noul" as const, instructions: "Did it ship?", criteria: { true: "Yes", false: "No" } } };
  model.decide({ shipped: 0.9 });
  await decide({}, question, { meter });
  expect(model.decisions.at(-1)!.model).toBe(DEFAULT_DECISION_MODEL);
  model.decide({ shipped: { yes: 1 } });
  await expect(decide({}, question, { meter })).rejects.toThrow();
  // The fake noticed the mismatch too.
  expect(() => model.done()).toThrow("a noul question answered with");
  // A probability outside 0 to 1 isn't one.
  model.decide({ shipped: 2 });
  await expect(decide({}, question, { meter })).rejects.toThrow("The decision model didn't answer shipped");
});

test("every answered request says what it used: tokens and cost, chat and decisions alike; a failed one isn't counted", async () => {
  useFake();
  const used: AiUsage[] = [];
  const record = async (usage: AiUsage) => void used.push(usage);
  model.reply("Hello");
  await complete({ system: "Be brief", user: "Hi", model: DEFAULT_AI_MODEL, meter: record });
  model.fail(500);
  await expect(complete({ system: "Be brief", user: "Hi", model: DEFAULT_AI_MODEL, meter: record })).rejects.toThrow();
  model.decide({ shipped: 0.9 });
  await decide({ pr: "x" }, { shipped: { type: "noul", instructions: "Did it ship?", criteria: { true: "Yes", false: "No" } } }, { meter: record });
  // Answered but unusable (an empty reply): still paid for, so still recorded.
  model.reply("  ");
  await expect(complete({ system: "Be brief", user: "Hi", model: DEFAULT_AI_MODEL, meter: record })).rejects.toThrow("The AI reply had no text");
  expect(used.splice(2).map((usage) => usage.kind)).toEqual(["chat"]);
  // The fake's usage: a token per character; chat a millionth of a dollar each, decisions a hundred-millionth.
  expect(used).toEqual([
    { kind: "chat", model: DEFAULT_AI_MODEL, inputTokens: 10, outputTokens: 5, cost: 15 / 1e6 },
    // The model that answered, as the reply names it.
    { kind: "decision", model: `${DEFAULT_DECISION_MODEL}-fake-build`, inputTokens: 10, outputTokens: 1, cost: 11 / 1e8 },
  ]);
});
