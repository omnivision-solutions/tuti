import { expect, test } from "vitest";

import { contentHash, embeddingsEnabled, postEmbeddingText, toVectorLiteral } from "./embeddings";

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
