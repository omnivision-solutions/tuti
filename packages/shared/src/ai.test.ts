import { configFile, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { embed } from "./embeddings";
import { AI_ROLE_NAMES, AI_ROLES, aiEnabled, complete, decide, DEFAULT_AI_MODEL, DEFAULT_DECISION_MODEL, DEFAULT_TRANSLATION_MODEL, defaultModel, listModels, modelMaxPrice, providerDidNotAnswer, roleCanBeOff, roleDefaultModel, roleNeedsTools, withinModelCap } from "./ai";
import { type AiUsage, replyCost } from "./usage";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
  // Each test reads only its own requests, whatever ran before it.
  model.requests.length = 0;
  model.decisions.length = 0;
  model.images.length = 0;
});

/** Usage goes nowhere, except in the tests about it. */
const meter = async () => {};
const ai = { model: "acme/writer", meter };

const useFake = () => {
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
};

test("AI is off without a key", async () => {
  expect(aiEnabled()).toBe(false);
  await expect(complete({ system: "s", user: "u", ...ai })).rejects.toThrow("OPENAI_API_KEY is not set");
});

test("sends the system and user messages to the model it's given, with the token cap, and returns the reply", async () => {
  useFake();
  expect(aiEnabled()).toBe(true);
  model.reply("Hello");
  expect(await complete({ system: "Be brief", user: "Hi", ...ai })).toBe("Hello");
  model.reply("Again");
  expect(await complete({ system: "Be brief", user: "Hi again", maxTokens: 300, model: "acme/tiny", meter })).toBe("Again");
  expect(model.requests).toMatchObject([
    { model: "acme/writer", system: "Be brief", user: "Hi", maxTokens: 4000 },
    { model: "acme/tiny", system: "Be brief", user: "Hi again", maxTokens: 300 },
  ]);
});

test("the provider didn't answer: a time limit, no connection, a rate limit, an error on its side; not a refusal, nor a reply that came empty or unreadable", async () => {
  useFake();
  const failure = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);
  const asked = () => failure(() => complete({ system: "s", user: "u", ...ai }));
  for (const status of [408, 429, 500, 502, 503, 529]) {
    model.fail(status);
    expect(providerDidNotAnswer(await asked()), `${status}`).toBe(true);
  }
  for (const status of [400, 401, 402, 403, 404]) {
    model.fail(status);
    expect(providerDidNotAnswer(await asked()), `${status}`).toBe(false);
  }
  // Answered (and paid for), but empty: asked again, it would most likely be empty again.
  model.reply(" ");
  expect(providerDidNotAnswer(await asked())).toBe(false);
  // Its time limit, no connection, the connection cut: thrown by fetch, before any answer (mocked: no socket is opened).
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const error of [new DOMException("The operation was aborted due to timeout", "TimeoutError"), new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }), new TypeError("terminated")]) {
    fetch.mockRejectedValueOnce(error);
    const thrown = await asked();
    expect(providerDidNotAnswer(thrown), error.message).toBe(true);
    expect(thrown).toMatchObject({ message: error.message, cause: error });
  }
  // A 200 whose body isn't JSON came back: not retried.
  fetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
  expect(providerDidNotAnswer(await asked())).toBe(false);
  // Decisions and embeddings fail the same way.
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }));
  expect(providerDidNotAnswer(await failure(() => decide({}, {}, { meter })))).toBe(true);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 }));
  expect(providerDidNotAnswer(await failure(() => decide({}, {}, { meter })))).toBe(false);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }));
  expect(providerDidNotAnswer(await failure(() => embed(["hi"])))).toBe(true);
  fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
  expect(providerDidNotAnswer(await failure(() => embed(["hi"])))).toBe(true);
  fetch.mockRestore();
  // Only the AI clients' own failures: the same errors from anywhere else (GitHub's requests) aren't the provider's.
  expect(providerDidNotAnswer(new TypeError("fetch failed"))).toBe(false);
  expect(providerDidNotAnswer(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(false);
  expect(providerDidNotAnswer(new Error("AI request failed (503): overloaded"))).toBe(false);
  expect(providerDidNotAnswer(new SyntaxError("Unexpected token"))).toBe(false);
  expect(providerDidNotAnswer("503")).toBe(false);
});

test("OpenRouter's own fields (data policy, cost) go only through OpenRouter: another provider refuses unknown ones", async () => {
  const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: "Hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply());
  const body = (call: number) => JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as Record<string, unknown>;
  vi.stubEnv("OPENAI_API_KEY", "sk-proj-other");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  await complete({ system: "s", user: "u", ...ai });
  expect(body(0)).not.toHaveProperty("provider");
  expect(body(0)).not.toHaveProperty("usage");
  vi.stubEnv("OPENAI_API_KEY", "sk-or-v1-test");
  vi.stubEnv("OPENAI_BASE_URL", "");
  await complete({ system: "s", user: "u", ...ai });
  expect(body(1)).toMatchObject({ provider: { data_collection: "deny" }, usage: { include: true } });
  fetch.mockRestore();
});

test("roles: each is a feature's kind of work, with that feature's default unless it's Autopilot's Decides or Checks; only Autopilot's take tools, only Checks can be off", () => {
  expect(AI_ROLE_NAMES.filter(roleNeedsTools)).toEqual(["code_changes_decide", "code_changes_check", "code_changes"]);
  expect(AI_ROLE_NAMES.filter(roleCanBeOff)).toEqual(["code_changes_check"]);
  expect([AI_ROLES.support_draft.feature, AI_ROLES.support_summary.feature]).toEqual(["support", "support"]);
  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { features: { support: "acme/inbox" } }, autopilot: { decide: { model: "acme/decider" }, redecide: { model: "acme/checker" }, write: { model: "acme/writer" } } }));
  expect(AI_ROLE_NAMES.map(roleDefaultModel)).toEqual([DEFAULT_AI_MODEL, DEFAULT_AI_MODEL, "acme/inbox", "acme/inbox", DEFAULT_AI_MODEL, "acme/decider", "acme/checker", "acme/writer", DEFAULT_TRANSLATION_MODEL]);
});

test("each feature's default model: its own setting, else ai.model, else Tuti's (for code changes, Autopilot's write model)", () => {
  expect(defaultModel("answers")).toBe(DEFAULT_AI_MODEL);
  expect(defaultModel("code_changes")).toBe("anthropic/claude-sonnet-5.5");
  vi.stubEnv("TUTI_CONFIG", configFile({ autopilot: { write: { model: "acme/writer" } } }));
  expect(defaultModel("code_changes")).toBe("acme/writer");
  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { model: "acme/everything", features: { codeChanges: "acme/careful" } } }));
  expect([defaultModel("answers"), defaultModel("escalations"), defaultModel("changelog"), defaultModel("code_changes")]).toEqual([
    "acme/everything",
    "acme/everything",
    "acme/everything",
    "acme/careful",
  ]);
  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { model: "acme/everything" } }));
  expect(defaultModel("code_changes")).toBe("acme/everything");
  // Translation has its own default, below ai.model and its own setting like the others.
  expect(defaultModel("translation")).toBe("acme/everything");
  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { features: { translation: "acme/translator" } } }));
  expect(defaultModel("translation")).toBe("acme/translator");
  vi.stubEnv("TUTI_CONFIG", "");
  expect(defaultModel("translation")).toBe(DEFAULT_TRANSLATION_MODEL);
});

test("lists the endpoint's models, with their prices per token and whether they take tool calls", async () => {
  await expect(listModels()).rejects.toThrow("OPENAI_API_KEY is not set");
  useFake();
  const models = await listModels();
  expect(models).toContainEqual({ id: DEFAULT_AI_MODEL, name: expect.any(String) as string, input: 1e-6, output: 5e-6, tools: true });
  expect(models.find((listed) => listed.id === "acme/no-tools")).toMatchObject({ tools: false });
  // An endpoint that doesn't say what a model takes: not ruled out.
  expect(models.find((listed) => listed.id === "acme/no-price")).toMatchObject({ input: null, output: null, tools: true });
});

test("the cap on the models projects pick: none unless ai.maxPrice is set; under one, only models priced at or under it", () => {
  const priced = (output: number | null) => ({ id: "acme/model", name: "Acme: Model", input: 0, output, tools: true });
  expect(modelMaxPrice()).toBeNull();
  expect(withinModelCap(priced(null))).toBe(true);
  for (const value of [0, -1, "lots"]) {
    vi.stubEnv("TUTI_CONFIG", configFile({ ai: { maxPrice: value } }));
    expect(() => modelMaxPrice()).toThrow(/ai\.maxPrice/);
  }

  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { maxPrice: 0.4 } }));
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

test("decisions go to the decision model, with the data policy, and come back as probabilities", async () => {
  useFake();
  vi.stubEnv("TUTI_CONFIG", configFile({ autopilot: { decisions: { model: "test/decider" } } }));
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
  model.reply("Hello");
  await complete({ system: "Be brief", user: "Hi", model: "acme/tiny", meter: record });
  model.fail(500);
  await expect(complete({ system: "Be brief", user: "Hi", model: DEFAULT_AI_MODEL, meter: record })).rejects.toThrow();
  model.decide({ shipped: 0.9 });
  await decide({ pr: "x" }, { shipped: { type: "noul", instructions: "Did it ship?", criteria: { true: "Yes", false: "No" } } }, { meter: record });
  // Answered but unusable (an empty reply): still paid for, so still recorded.
  model.reply("  ");
  await expect(complete({ system: "Be brief", user: "Hi", model: DEFAULT_AI_MODEL, meter: record })).rejects.toThrow("The AI reply had no text");
  expect(used.splice(3).map((usage) => usage.kind)).toEqual(["chat"]);
  // The fake's usage: a token per character; chat a millionth of a dollar each, decisions a hundred-millionth.
  expect(used).toEqual([
    // Through our own key (BYOK) or not, the same price.
    { kind: "chat", model: DEFAULT_AI_MODEL, inputTokens: 10, outputTokens: 5, cost: 15 / 1e6 },
    { kind: "chat", model: "acme/tiny", inputTokens: 10, outputTokens: 5, cost: 15 / 1e6 },
    // The model that answered, as the reply names it.
    { kind: "decision", model: `${DEFAULT_DECISION_MODEL}-fake-build`, inputTokens: 10, outputTokens: 1, cost: 11 / 1e8 },
  ]);
});

test("a request's cost is what OpenRouter charged, plus the provider's charge when it went through our own key", () => {
  // BYOK: OpenRouter's fee (none within its allowance) and the provider's charge.
  expect(replyCost({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0013 } })).toBe(0.0013);
  expect(replyCost({ cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.0013 } })).toBeCloseTo(0.0014);
  // Otherwise the upstream cost is already in the cost.
  expect(replyCost({ cost: 0.0013, is_byok: false, cost_details: { upstream_inference_cost: 0.0013 } })).toBe(0.0013);
  expect(replyCost({ cost: 0.0013, cost_details: null })).toBe(0.0013);
  // Neither reported (another OpenAI-compatible endpoint).
  expect(replyCost({})).toBeNull();
  expect(replyCost(undefined)).toBeNull();
  // BYOK without the provider's charge: unknown, not free.
  expect(replyCost({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: null } })).toBeNull();
  expect(replyCost({ cost: 0, is_byok: true })).toBeNull();
});

test("an image's shape: the closest aspect ratio, the smallest resolution that holds the size once cropped, and the crop that's notable", async () => {
  const { imageShape } = await import("./ai");
  // Exactly a ratio: nothing cropped; 1K holds 1376×768-ish, 2K a size past it.
  expect(imageShape(1024, 1024)).toEqual({ aspectRatio: "1:1", imageSize: "1K", cropped: null });
  expect(imageShape(1280, 720)).toEqual({ aspectRatio: "16:9", imageSize: "1K", cropped: null });
  expect(imageShape(1920, 1080)).toEqual({ aspectRatio: "16:9", imageSize: "2K", cropped: null });
  // Square past 2K's 2048: 4K.
  expect(imageShape(2400, 2400)).toEqual({ aspectRatio: "1:1", imageSize: "4K", cropped: null });
  // A changelog cover, 1600×840 (1.9): 16:9 is closest, with 7% cropped off the top and bottom; 1300×720, 2%, isn't notable.
  expect(imageShape(1600, 840)).toEqual({ aspectRatio: "16:9", imageSize: "2K", cropped: "top and bottom" });
  expect(imageShape(1300, 720)).toEqual({ aspectRatio: "16:9", imageSize: "1K", cropped: null });
  // Google's own sizes, not a constant area: 3:2 at 1K is 1264×848, which holds 1260×840.
  expect(imageShape(1260, 840)).toEqual({ aspectRatio: "3:2", imageSize: "1K", cropped: null });
  // Compared in log space: 2.2 is nearer 21:9 (2.33) than 16:9 (1.78).
  expect(imageShape(2200, 1000).aspectRatio).toBe("21:9");
  // Narrower and wider than any ratio: the most extreme, cropped to the size's shape (1:8's 1K is 362×2896).
  expect(imageShape(64, 2400)).toEqual({ aspectRatio: "1:8", imageSize: "1K", cropped: "left and right" });
  expect(imageShape(2400, 200)).toEqual({ aspectRatio: "8:1", imageSize: "1K", cropped: "top and bottom" });
  // 0.9, between 4:5 and 1:1: the square, its sides cropped off.
  expect(imageShape(900, 1000)).toMatchObject({ aspectRatio: "1:1", cropped: "left and right" });
});

test("an image: the image model gets the prompt, the references and the image config with OpenRouter's fields; its usage is metered and its bytes returned", async () => {
  useFake();
  const { generateImage, imageModel, imagesEnabled } = await import("./ai");
  const { DEFAULT_IMAGE_MODEL } = await import("./config");
  expect(imagesEnabled()).toBe(true);
  expect(imageModel()).toBe("google/gemini-nano-banana-2.1");
  const used: AiUsage[] = [];
  const png = await generateImage({ prompt: "A lighthouse", references: ["data:image/webp;base64,AAAA"], aspectRatio: "16:9", imageSize: "1K", meter: async (usage) => void used.push(usage) });
  // A PNG, as the fake made it.
  expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  expect(model.images).toEqual([
    {
      model: DEFAULT_IMAGE_MODEL,
      prompt: "A lighthouse",
      references: ["data:image/webp;base64,AAAA"],
      aspectRatio: "16:9",
      imageSize: "1K",
      provider: { data_collection: "deny" },
      usage: { include: true },
    },
  ]);
  expect(used).toEqual([{ kind: "chat", model: DEFAULT_IMAGE_MODEL, inputTokens: "A lighthouse".length, outputTokens: 1290, cost: 0.01 }]);

  // The config file's model is the one asked.
  vi.stubEnv("TUTI_CONFIG", configFile({ ai: { imageModel: "acme/painter" } }));
  await generateImage({ prompt: "A boat", references: [], aspectRatio: "1:1", imageSize: "2K", meter });
  expect(model.images[1]).toMatchObject({ model: "acme/painter", references: [], aspectRatio: "1:1", imageSize: "2K" });
});

test("images need OpenRouter: off without a key, and with another provider's", async () => {
  const { imagesEnabled } = await import("./ai");
  expect(imagesEnabled()).toBe(false);
  vi.stubEnv("OPENAI_API_KEY", "sk-other");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.example.com/v1");
  expect(imagesEnabled()).toBe(false);
});
