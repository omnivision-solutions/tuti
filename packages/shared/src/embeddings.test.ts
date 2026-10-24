import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { contentHash, embed, EMBEDDING_DOLLARS_PER_TOKEN, EMBEDDING_MODEL, embeddingsEnabled, postEmbeddingText, toVectorLiteral } from "./embeddings";
import type { AiUsage } from "./usage";

/** Usage goes nowhere, except in the test about it. */
const meter = async () => {};

test("embeddings are off without an OpenAI key", () => {
  expect(embeddingsEnabled()).toBe(false);
});

test("post text is title then body, trimmed and capped", () => {
  expect(postEmbeddingText({ title: "Dark mode", body: "" })).toBe("Dark mode");
  expect(postEmbeddingText({ title: "Dark mode", body: "Please" })).toBe("Dark mode\n\nPlease");
  expect(postEmbeddingText({ title: "x", body: "y".repeat(10_000) })).toHaveLength(8000);
});

test("content hash changes with the text", () => {
  expect(contentHash("a")).toBe(contentHash("a"));
  expect(contentHash("a")).not.toBe(contentHash("b"));
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

  test("vectors can be set over HTTP (for other processes); bad bodies get a 400", async () => {
    const post = (body: string) =>
      fetch(`${openai.url}/fixtures`, {
        method: "POST",
        headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}`, "content-type": "application/json" },
        body,
      });
    expect((await post(JSON.stringify({ text: "csv export", vector: [0, 1] }))).status).toBe(204);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ text: "csv export" }))).status).toBe(400);
    expect((await post(JSON.stringify({ text: "x", vector: Array(65).fill(0) }))).status).toBe(400);
    // Still serving, with the vector that was set.
    const [vector] = await embed(["csv export"], { meter });
    expect(vector!.slice(0, 2)).toEqual([0, 1]);
  });

  test("returns one vector per text, in input order", async () => {
    openai.setVector("dark mode", [1, 0]);
    openai.setVector("night theme", [0.8, 0.6]);
    const [a, b] = await embed(["dark mode", "night theme"], { meter });
    expect(a).toHaveLength(1536);
    expect(a!.slice(0, 2)).toEqual([1, 0]);
    expect(b!.slice(0, 2)).toEqual([0.8, 0.6]);
    expect(openai.inputs.slice(-2)).toEqual(["dark mode", "night theme"]);
    expect(openai.models.at(-1)).toBe(EMBEDDING_MODEL);
  });

  test("texts without a fixture are unrelated to each other", async () => {
    const [a, b] = await embed(["export to csv", "sso with okta"], { meter });
    expect(a!.reduce((sum, value, i) => sum + value * b![i]!, 0)).toBe(0);
  });

  test("says what it used: the inputs' tokens, at the model's list price", async () => {
    const used: AiUsage[] = [];
    await embed(["dark mode", "csv"], { meter: async (usage) => void used.push(usage) });
    // The fake counts a token per character.
    expect(used).toEqual([{ kind: "embedding", model: EMBEDDING_MODEL, inputTokens: 12, outputTokens: 0, cost: 12 * EMBEDDING_DOLLARS_PER_TOKEN }]);
  });

  test("reports API errors", async () => {
    openai.failNext(429);
    await expect(embed(["x"], { meter })).rejects.toThrow("OpenAI embeddings failed (429): fake failure");
  });

  test("needs a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(embed(["x"], { meter })).rejects.toThrow("OPENAI_API_KEY is not set");
  });
});
