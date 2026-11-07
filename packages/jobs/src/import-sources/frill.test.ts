import { FAKE_FRILL_KEY, type FrillFake, frillFixtures, startFrillFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { frill, FrillError, frillSource } from "./frill";

let fake: FrillFake;
const waits: number[] = [];
const client = (key = FAKE_FRILL_KEY) => frill(key, Infinity, async (ms) => void waits.push(ms));

beforeAll(async () => {
  fake = await startFrillFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  vi.stubEnv("FRILL_API_URL", fake.env.FRILL_API_URL);
  fake.requests.length = 0;
  waits.length = 0;
});

test("requests are GETs with the key as a Bearer token and the query in the address", async () => {
  expect((await client()<{ data: unknown[] }>("followers", { limit: 1, after: null })).data).toHaveLength(1);
  expect(fake.requests).toEqual(["GET /v1/followers?limit=1"]);
});

test("a key Frill refuses is a refusal (401) and isn't tried again", async () => {
  const error = await client("wrong")("ideas").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(FrillError);
  expect(error).toMatchObject({ status: 401, message: "Unauthenticated." });
  expect(waits).toEqual([]);
});

test("rate limits and server errors are tried again, waiting longer each time or as Retry-After says; then it gives up, saying so", async () => {
  fake.failNext(429, 2);
  await client()("ideas");
  expect(waits).toEqual([500, 1000]);

  waits.length = 0;
  fake.failNext(429, 1, { "retry-after": "3" });
  await client()("ideas");
  expect(waits).toEqual([3000]);

  waits.length = 0;
  fake.failNext(500, 5);
  expect(await client()("ideas").catch((e: unknown) => e)).toMatchObject({ status: 500, message: "fake failure" });
  expect(waits).toEqual([500, 1000, 2000, 4000]);
});

const readers = () => frillSource.connect(FAKE_FRILL_KEY, { deadline: Infinity }).read;

test("comments are read idea by idea, oldest first; an idea gone between pages doesn't skip the next one's", async () => {
  fake.pageSize = 2;
  try {
    const first = await readers().comments!(null);
    expect(first.items.map((comment) => [comment.id, comment.postId, comment.isPrivate, comment.author?.type])).toEqual([
      ["comment_yes", "idea_dark", false, "lead"],
      ["comment_note", "idea_dark", true, "admin"],
    ]);
    // Deleted in Frill before the next page: the next idea is still CSV export.
    fake.fixtures.ideas.splice(0, 1);
    const second = await readers().comments!(first.next);
    expect(second.items.map((comment) => comment.id)).toEqual(["comment_list"]);
  } finally {
    fake.pageSize = 100;
    fake.fixtures = frillFixtures();
  }
});

test("statuses by their words, from a word's start: Incomplete or Abandoned aren't done, Unplanned isn't planned", async () => {
  const names = ["Shipped", "In Development", "Not planned", "Incomplete", "Abandoned", "Unplanned"];
  fake.fixtures.ideas = names.map((name, i) => ({ ...frillFixtures().ideas[1]!, idx: `idea_${i}`, status: { idx: `status_${i}`, name } }));
  try {
    const { items } = await readers().posts!(null);
    expect(items.map((post) => post.status.type ?? null)).toEqual(["completed", "active", "canceled", null, null, null]);
  } finally {
    fake.fixtures = frillFixtures();
  }
});
