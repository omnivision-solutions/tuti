import { afterAll, beforeAll, expect, test } from "vitest";

import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "./openai-fake";

let openai: OpenAIFake;
beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());

const post = (path: string, body: string) =>
  fetch(`${openai.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${FAKE_OPENAI_KEY}`, "content-type": "application/json" }, body });
const embed = async (input: string[]) => {
  const { data } = (await (await post("/embeddings", JSON.stringify({ model: "text-embedding-3-small", input }))).json()) as { data: { index: number; embedding: number[] }[] };
  return data.sort((a, b) => a.index - b.index).map(({ embedding }) => embedding);
};

test("vectors can be set over HTTP (for other processes); bad bodies get a 400", async () => {
  expect((await post("/fixtures", JSON.stringify({ text: "csv export", vector: [0, 1] }))).status).toBe(204);
  expect((await post("/fixtures", "not json")).status).toBe(400);
  expect((await post("/fixtures", JSON.stringify({ text: "csv export" }))).status).toBe(400);
  expect((await post("/fixtures", JSON.stringify({ text: "x", vector: Array(65).fill(0) }))).status).toBe(400);
  // Still serving, with the vector that was set.
  const [vector] = await embed(["csv export"]);
  expect(vector!.slice(0, 2)).toEqual([0, 1]);
});

test("texts without a fixture are unrelated to each other", async () => {
  const [a, b] = await embed(["export to csv", "sso with okta"]);
  expect(a!.reduce((sum, value, i) => sum + value * b![i]!, 0)).toBe(0);
});
