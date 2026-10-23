import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { aiEnabled, complete, decide, DEFAULT_AI_MODEL, DEFAULT_DECISION_MODEL } from "./ai";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

const useFake = () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
};

test("AI is off without an OpenRouter key", async () => {
  expect(aiEnabled()).toBe(false);
  await expect(complete({ system: "s", user: "u" })).rejects.toThrow("OPENROUTER_API_KEY is not set");
});

test("sends the system and user messages to the configured model, with the token cap, and returns the reply", async () => {
  useFake();
  expect(aiEnabled()).toBe(true);
  model.reply("Hello");
  expect(await complete({ system: "Be brief", user: "Hi" })).toBe("Hello");
  vi.stubEnv("AI_MODEL", "acme/tiny");
  model.reply("Again");
  expect(await complete({ system: "Be brief", user: "Hi again", maxTokens: 300 })).toBe("Again");
  expect(model.requests).toEqual([
    { model: DEFAULT_AI_MODEL, system: "Be brief", user: "Hi", maxTokens: 4000 },
    { model: "acme/tiny", system: "Be brief", user: "Hi again", maxTokens: 300 },
  ]);
});

test("a failed request or an empty reply throws", async () => {
  useFake();
  model.fail(429);
  await expect(complete({ system: "s", user: "u" })).rejects.toThrow("AI request failed (429): fake failure");
  model.reply("  ");
  await expect(complete({ system: "s", user: "u" })).rejects.toThrow("The AI reply had no text");
});

test("the model fake keeps a reply with a match for the request that contains it", async () => {
  useFake();
  model.reply("For the question", undefined, "How do I invite?");
  model.reply("For anything");
  expect(await complete({ system: "s", user: "Draft the notes" })).toBe("For anything");
  expect(await complete({ system: "s", user: "Question: How do I invite?" })).toBe("For the question");
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
  await decide({}, question);
  expect(model.decisions.at(-1)!.model).toBe(DEFAULT_DECISION_MODEL);
  model.decide({ shipped: { yes: 1 } });
  await expect(decide({}, question)).rejects.toThrow();
  // The fake noticed the mismatch too.
  expect(() => model.done()).toThrow("a noul question answered with");
  // A probability outside 0 to 1 isn't one.
  model.decide({ shipped: 2 });
  await expect(decide({}, question)).rejects.toThrow("The decision model didn't answer shipped");
});
