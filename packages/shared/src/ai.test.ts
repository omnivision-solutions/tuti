import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { aiEnabled, complete, DEFAULT_AI_MODEL } from "./ai";

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
