import { createHash } from "node:crypto";

import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { contentHash, embed, EMBEDDING_MODEL, embeddingsEnabled, postEmbeddingText, toVectorLiteral } from "./embeddings";

test("embeddings are off without an OpenAI key", () => {
  expect(embeddingsEnabled()).toBe(false);
});

test("post text is title then body, trimmed and capped", () => {
  expect(postEmbeddingText({ title: "Dark mode", body: "" })).toBe("Dark mode");
  expect(postEmbeddingText({ title: "Dark mode", body: "Please" })).toBe("Dark mode\n\nPlease");
  expect(postEmbeddingText({ title: "x", body: "y".repeat(10_000) })).toHaveLength(8000);
});

test("vector literal", () => {
  expect(toVectorLiteral([0.1, -2, 3])).toBe("[0.1,-2,3]");
});

describe("embed", () => {
  let openai: OpenAIFake;
  beforeAll(async () => {
    openai = await startOpenAIFake();
  });
  afterAll(() => openai.close());
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
    vi.stubEnv("OPENAI_BASE_URL", openai.url);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns one vector per text, in input order", async () => {
    openai.setVector("dark mode", [1, 0]);
    openai.setVector("night theme", [0.8, 0.6]);
    const [a, b] = await embed(["dark mode", "night theme"]);
    expect(a).toHaveLength(1536);
    expect(a!.slice(0, 2)).toEqual([1, 0]);
    expect(b!.slice(0, 2)).toEqual([0.8, 0.6]);
    expect(openai.inputs.slice(-2)).toEqual(["dark mode", "night theme"]);
    expect(openai.models.at(-1)).toBe(EMBEDDING_MODEL);
  });

  test("reports API errors", async () => {
    openai.failNext(429);
    await expect(embed(["x"])).rejects.toThrow("Embeddings failed (429): fake failure");
  });

  test("asks OpenRouter for the model by its id there; the hash keeps the stored name", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-or-v1-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })));
    expect(await embed(["x"])).toEqual([[1]]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/embeddings");
    // Only providers that neither train on the text nor keep it, as for every other OpenRouter request.
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "openai/text-embedding-3-small", provider: { data_collection: "deny" } });
    expect(contentHash("x")).toBe(createHash("sha256").update("text-embedding-3-small\nx").digest("hex"));
    fetch.mockRestore();
  });

  test("OpenAI's own API gets no provider field (it refuses unknown ones)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })));
    await embed(["x"]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ model: "text-embedding-3-small", input: ["x"] });
    fetch.mockRestore();
  });

  test("an error that isn't JSON (a proxy's page) still says its status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-test");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Unauthorized</html>", { status: 401 }));
    await expect(embed(["x"])).rejects.toThrow("Embeddings failed (401): no data");
    fetch.mockRestore();
  });

  test("needs a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(embed(["x"])).rejects.toThrow("OPENAI_API_KEY is not set");
  });
});
