import { FAKE_MODEL_KEY, type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { aiEnabled, aiProvider, checkAiProvider, codeChangesEnabled, codeChangesFix, decisionsMissing, openRouterFix, shownAddress } from "./ai";
import { embeddingModelId, embeddingsEnabled } from "./embeddings";
import { log } from "./log";
import { chatEndpoint, embeddingsEndpoint } from "./provider";

let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const env = (vars: Record<string, string>) => Object.entries(vars).forEach(([name, value]) => vi.stubEnv(name, value));
const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
/** Where each kind of request goes, with which key; chat's key undefined when chat is off. */
const where = () => ({
  chat: [chatEndpoint().apiKey, chatEndpoint().baseUrl],
  embeddings: [embeddingsEndpoint().apiKey, embeddingsEndpoint().baseUrl, embeddingModelId()],
  ai: aiEnabled(),
  embed: embeddingsEnabled(),
});

test("1. OPENROUTER_API_KEY set: as before, chat on OpenRouter's settings, embeddings on OpenAI's", () => {
  env({ OPENROUTER_API_KEY: "sk-or-old" });
  expect(where()).toEqual({ chat: ["sk-or-old", OPENROUTER], embeddings: [undefined, OPENAI, "text-embedding-3-small"], ai: true, embed: false });
  env({ OPENROUTER_BASE_URL: "https://llm.example.com/v1/", OPENAI_API_KEY: "sk-proj-old" });
  expect(where()).toEqual({ chat: ["sk-or-old", "https://llm.example.com/v1"], embeddings: ["sk-proj-old", OPENAI, "text-embedding-3-small"], ai: true, embed: true });
  // Both names' URLs set: each kind keeps its own (embeddings at Azure, a local server…, as before).
  env({ OPENAI_BASE_URL: "https://embed.example.com/v1" });
  expect(where().embeddings).toEqual(["sk-proj-old", "https://embed.example.com/v1", "text-embedding-3-small"]);
});

test("1, mixed: with OPENROUTER_API_KEY and an OpenRouter key in OPENAI_API_KEY, embeddings go to OpenRouter (OPENAI_BASE_URL still wins)", () => {
  env({ OPENROUTER_API_KEY: "sk-or-old", OPENAI_API_KEY: "sk-or-v1-new" });
  expect(where()).toEqual({ chat: ["sk-or-old", OPENROUTER], embeddings: ["sk-or-v1-new", OPENROUTER, "openai/text-embedding-3-small"], ai: true, embed: true });
  env({ OPENAI_BASE_URL: "http://localhost:8080/v1" });
  // An OpenRouter key at another address: a proxy in front of OpenRouter, so OpenRouter's model id.
  expect(where().embeddings).toEqual(["sk-or-v1-new", "http://localhost:8080/v1", "openai/text-embedding-3-small"]);
});

test("2. OPENAI_BASE_URL set: chat, embeddings and decisions all there, with OPENAI_API_KEY", () => {
  env({ OPENAI_API_KEY: "sk-any", OPENAI_BASE_URL: "https://llm.example.com/v1" });
  expect(where()).toEqual({ chat: ["sk-any", "https://llm.example.com/v1"], embeddings: ["sk-any", "https://llm.example.com/v1", "text-embedding-3-small"], ai: true, embed: true });
  // OpenRouter's address: its id for the model.
  env({ OPENAI_BASE_URL: `${OPENROUTER}/` });
  expect(where()).toEqual({ chat: ["sk-any", OPENROUTER], embeddings: ["sk-any", OPENROUTER, "openai/text-embedding-3-small"], ai: true, embed: true });
});

test("3. an OpenRouter key without a URL: everything on OpenRouter", () => {
  env({ OPENAI_API_KEY: "sk-or-v1-new" });
  expect(where()).toEqual({ chat: ["sk-or-v1-new", OPENROUTER], embeddings: ["sk-or-v1-new", OPENROUTER, "openai/text-embedding-3-small"], ai: true, embed: true });
});

test("4. another key without a URL: the old meaning, embeddings on OpenAI and chat off (the key never goes elsewhere)", () => {
  env({ OPENAI_API_KEY: "sk-proj-embeddings" });
  expect(where()).toEqual({ chat: [undefined, OPENAI], embeddings: ["sk-proj-embeddings", OPENAI, "text-embedding-3-small"], ai: false, embed: true });
});

test("5. neither key: AI off", () => {
  env({ OPENAI_BASE_URL: "https://llm.example.com/v1", OPENROUTER_BASE_URL: "https://llm.example.com/v1" });
  expect(where()).toMatchObject({ ai: false, embed: false });
});

test("logs show an address without its user, password or query", () => {
  expect(shownAddress("https://user:secret@llm.example.com/v1/token-secret?key=secret")).toBe("https://llm.example.com");
  expect(shownAddress("llm.example.com/v1")).toBe("an address that isn't a URL");
  // Without a scheme, a port makes it parse with the host as the scheme: still not an address.
  expect(shownAddress("llm.example.com:8080/v1")).toBe("an address that isn't a URL");
  expect(shownAddress("user:token@llm.example.com/v1")).toBe("an address that isn't a URL");
});

test("what Autopilot and Verify still need: embeddings, when an old OpenRouter-only setup has the rest", () => {
  env({ OPENROUTER_API_KEY: "sk-or-old" });
  expect(codeChangesEnabled()).toBe(false);
  expect(codeChangesFix()).toBe("a key for embeddings in OPENAI_API_KEY (an OpenRouter or OpenAI key; see .env.example)");
  env({ OPENAI_API_KEY: "sk-proj-other", OPENAI_BASE_URL: "https://llm.example.com/v1", OPENROUTER_API_KEY: "" });
  expect(codeChangesFix()).toBe("an OpenRouter key in OPENAI_API_KEY, with OPENAI_BASE_URL unset (see .env.example)");
});

test("how to turn OpenRouter on names the variables this server reads", () => {
  env({ OPENAI_API_KEY: "sk-proj-other", OPENAI_BASE_URL: "https://llm.example.com/v1" });
  expect(openRouterFix()).toBe("an OpenRouter key in OPENAI_API_KEY, with OPENAI_BASE_URL unset (see .env.example)");
  // The old names, while they're set, win: the hint says to change those.
  env({ OPENROUTER_API_KEY: "sk-proj-other", OPENROUTER_BASE_URL: "https://llm.example.com/v1" });
  expect(openRouterFix()).toBe("an OpenRouter key in OPENROUTER_API_KEY, with OPENROUTER_BASE_URL unset (see .env.example)");
});

test("an address that isn't a URL: nothing throws, and start-up says which variable to fix", async () => {
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  env({ OPENAI_API_KEY: "sk-proj-other", OPENAI_BASE_URL: "llm.example.com/v1" });
  expect(() => codeChangesEnabled()).not.toThrow();
  expect(codeChangesEnabled()).toBe(false);
  // Autopilot's page names the provider, never the address itself (it could hold credentials).
  expect(decisionsMissing()).toBe(true);
  expect(aiProvider()).toBe("an address that isn't a URL");
  await expect(checkAiProvider()).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith("OPENAI_BASE_URL isn't a URL (it needs https://…): AI won't work until it's fixed");
});

test("start-up: the deprecated names and the embeddings-only key each get a warning; a good endpoint logs nothing else", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  await checkAiProvider();
  expect([warn.mock.calls, error.mock.calls]).toEqual([[], []]);

  env(model.env);
  await checkAiProvider();
  expect([warn.mock.calls, error.mock.calls]).toEqual([[], []]);

  env({ OPENROUTER_API_KEY: FAKE_MODEL_KEY, OPENROUTER_BASE_URL: model.url, OPENAI_API_KEY: "" });
  await checkAiProvider();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![0]).toMatch(/OPENROUTER_API_KEY and OPENROUTER_BASE_URL are deprecated.*set OPENAI_API_KEY/);
  expect(error).not.toHaveBeenCalled();

  warn.mockClear();
  env({ OPENROUTER_API_KEY: "", OPENROUTER_BASE_URL: "", OPENAI_API_KEY: "sk-proj-embeddings", OPENAI_BASE_URL: "" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  await checkAiProvider();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![0]).toMatch(/embeddings only.*set OPENAI_BASE_URL/);
});

test("start-up: an old setup's embeddings key is checked too, apart from chat's", async () => {
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  env({ OPENROUTER_API_KEY: "sk-or-good", OPENAI_API_KEY: "sk-proj-revoked" });
  // OpenRouter's models and key answer; OpenAI turns the embeddings key down.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response('{"data":[]}', { status: String(url).startsWith(OPENAI) ? 401 : 200 }));
  await checkAiProvider();
  expect(error.mock.calls.map(([message]) => String(message)).filter((message) => /turned down/.test(message))).toEqual([
    "The AI provider at https://api.openai.com turned down OPENAI_API_KEY for embeddings (401): the key looks wrong. Search by meaning and duplicates will fail until it's fixed.",
  ]);
});

test("start-up: an embeddings key that may embed but not list models (OpenAI's restricted keys) is fine", async () => {
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  env({ OPENROUTER_API_KEY: "sk-or-good", OPENAI_API_KEY: "sk-proj-restricted" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const at = String(url);
    if (at === `${OPENAI}/models`) return new Response('{"error":{"message":"Missing scopes: api.model.read"}}', { status: 403 });
    if (at === `${OPENAI}/embeddings`) return new Response('{"data":[{"index":0,"embedding":[1]}]}', { status: 200 });
    return new Response('{"data":[]}', { status: 200 });
  });
  await checkAiProvider();
  expect(error.mock.calls.map(([message]) => String(message)).filter((message) => /embeddings|turned down/.test(message))).toEqual([]);
});

test("start-up: one error saying whether the key or the address looks wrong, never a throw", async () => {
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  env({ OPENAI_API_KEY: "sk-or-wrong", OPENAI_BASE_URL: model.url });
  await checkAiProvider();
  expect(error).toHaveBeenCalledOnce();
  expect(error.mock.calls[0]![0]).toMatch(/turned down OPENAI_API_KEY \(401\): the key looks wrong/);

  error.mockClear();
  env({ OPENAI_API_KEY: FAKE_MODEL_KEY, OPENAI_BASE_URL: "http://127.0.0.1:1" });
  await checkAiProvider();
  expect(error).toHaveBeenCalledOnce();
  expect(error.mock.calls[0]![0]).toMatch(/Couldn't list the AI models at http:\/\/127.0.0.1:1 \(no answer\): the address \(OPENAI_BASE_URL\) looks wrong/);

  // OpenRouter lists its models to anyone: its /key says whether the key is good.
  error.mockClear();
  env({ OPENAI_API_KEY: "sk-or-wrong", OPENAI_BASE_URL: "" });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response("{}", { status: String(url).endsWith("/key") ? 401 : 200 }));
  await checkAiProvider();
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`${OPENROUTER}/models`, `${OPENROUTER}/key`]);
  expect(error.mock.calls[0]![0]).toMatch(/turned down OPENAI_API_KEY \(401\)/);
});

test("start-up: an endpoint without the chat model the server uses (AI_MODEL, a feature's, or the default) says what to set", async () => {
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  env({ ...model.env, AI_MODEL: "acme/imaginary", AI_MODEL_ANSWERS: "acme/tiny" });
  await checkAiProvider();
  expect(error).toHaveBeenCalledOnce();
  expect(error.mock.calls[0]![0]).toBe(
    `The AI provider at ${model.url} doesn't list the chat model acme/imaginary: set AI_MODEL (or a feature's AI_MODEL_<FEATURE>) to a model it serves. AI features using it will fail until then.`,
  );

  // An embeddings-only server has no chat model to look for.
  error.mockClear();
  env({ ...model.env, AI_MODEL: "acme/imaginary", OPENAI_BASE_URL: "", OPENAI_API_KEY: "sk-proj-embeddings" });
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await checkAiProvider();
  expect(error).not.toHaveBeenCalled();
});

test("Autopilot and Verify (codeChangesEnabled) are on only with OpenRouter's Decisions API: at openrouter.ai, or with an OpenRouter key", () => {
  // No AI: the hints say AI is off, not that decisions are missing.
  expect(decisionsMissing()).toBe(false);
  // OpenRouter: on.
  env({ OPENAI_API_KEY: "sk-or-v1-new" });
  expect([codeChangesEnabled(), decisionsMissing()]).toEqual([true, false]);
  // Azure-style: another provider's key at its own address. AI on, but no decisions, so off.
  env({ OPENAI_API_KEY: "azure-key", OPENAI_BASE_URL: "https://acme.openai.azure.com/openai/v1" });
  expect([aiEnabled(), codeChangesEnabled(), decisionsMissing()]).toEqual([true, false, true]);
  // An OpenRouter key through another address (a proxy in front of OpenRouter, the tests' fake): on.
  env({ OPENAI_API_KEY: "sk-or-v1-new", OPENAI_BASE_URL: "https://llm-proxy.example.com/v1" });
  expect(codeChangesEnabled()).toBe(true);
  env(model.env);
  expect(codeChangesEnabled()).toBe(true);
  // The deprecated names: the same, by OPENROUTER_*.
  env({ OPENROUTER_API_KEY: "or-old", OPENAI_API_KEY: "sk-proj-old", OPENAI_BASE_URL: "" });
  expect(codeChangesEnabled()).toBe(true);
  // An old setup's own gateway, whatever its key: OpenRouter behind it, as before this release.
  env({ OPENROUTER_API_KEY: "sk-litellm-gateway", OPENROUTER_BASE_URL: "https://llm-gw.example.com/v1" });
  expect(codeChangesEnabled()).toBe(true);
});

test("start-up: an endpoint without the Decisions API says once that Autopilot and Verify need it", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "anthropic/claude-haiku-5.5" }] })));
  env({ OPENAI_API_KEY: "azure-key", OPENAI_BASE_URL: "https://acme.openai.azure.com/openai/v1" });
  await checkAiProvider();
  expect(warn.mock.calls).toEqual([["Autopilot and Verify need OpenRouter's Decisions API; acme.openai.azure.com doesn't have it"]]);

  // OpenRouter, or the fake (an OpenRouter key): nothing.
  warn.mockClear();
  env({ OPENAI_API_KEY: "sk-or-v1-new", OPENAI_BASE_URL: "" });
  await checkAiProvider();
  env(model.env);
  vi.mocked(globalThis.fetch).mockRestore();
  await checkAiProvider();
  expect([warn.mock.calls, error.mock.calls]).toEqual([[], []]);
});
