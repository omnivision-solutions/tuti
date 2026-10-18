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

  test("texts without a fixture are unrelated to each other", async () => {
    const [a, b] = await embed(["export to csv", "sso with okta"]);
    expect(a!.reduce((sum, value, i) => sum + value * b![i]!, 0)).toBe(0);
  });

  test("reports API errors", async () => {
    openai.failNext(429);
    await expect(embed(["x"])).rejects.toThrow("OpenAI embeddings failed (429): fake failure");
  });

  test("needs a key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(embed(["x"])).rejects.toThrow("OPENAI_API_KEY is not set");
  });
});
