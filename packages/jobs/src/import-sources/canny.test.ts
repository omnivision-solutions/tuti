import { type CannyFake, FAKE_CANNY_KEY, startCannyFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { canny, CannyError, textHtml } from "./canny";

let fake: CannyFake;
const waits: number[] = [];
const client = (deadline = Infinity, key = FAKE_CANNY_KEY) => canny(key, deadline, async (ms) => void waits.push(ms));

beforeAll(async () => {
  fake = await startCannyFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  vi.stubEnv("CANNY_API_URL", fake.env.CANNY_API_URL);
  fake.requests.length = 0;
  waits.length = 0;
});

test("every request is a POST with the key in its body", async () => {
  expect((await client()<{ boards: unknown[] }>("v1/boards/list")).boards).toHaveLength(2);
  expect(fake.requests).toEqual(["POST /v1/boards/list {}"]);
});

test("a key Canny refuses is a refusal (401), whatever code it answers with, and isn't tried again", async () => {
  const error = await client(Infinity, "wrong")("v1/boards/list").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CannyError);
  expect(error).toMatchObject({ status: 401, message: "invalid api key" });
  expect(waits).toEqual([]);
});

test("rate limits and server errors are tried again, waiting longer each time; then it gives up, saying so", async () => {
  fake.failNext(429, 2);
  await client()("v1/boards/list");
  expect(waits).toEqual([500, 1000]);

  waits.length = 0;
  fake.failNext(500, 5);
  expect(await client()("v1/boards/list").catch((e: unknown) => e)).toMatchObject({ status: 500, message: "fake failure" });
  expect(waits).toEqual([500, 1000, 2000, 4000]);
});

test("Retry-After is honoured, up to a minute; a wait past the deadline isn't waited, the last error said instead", async () => {
  fake.failNext(429, 1, { "retry-after": "30" });
  await client()("v1/boards/list");
  fake.failNext(429, 1, { "retry-after": "120" });
  await client()("v1/boards/list");
  expect(waits).toEqual([30_000, 60_000]);

  waits.length = 0;
  fake.failNext(429, 1, { "retry-after": "30" });
  expect(await client(Date.now() + 5_000)("v1/boards/list").catch((e: unknown) => e)).toMatchObject({ status: 429 });
  expect(waits).toEqual([]);
});

test("Canny's plain text as HTML: paragraphs, line breaks, its images after, nothing of its own taken as markup", () => {
  expect(textHtml("One <b>\nline\n\nTwo", ["https://canny.io/images/a.png?x=1&y=2"])).toBe('<p>One &lt;b&gt;<br>line</p><p>Two</p><p><img src="https://canny.io/images/a.png?x=1&amp;y=2"></p>');
});
