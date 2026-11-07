import { FAKE_NOLT_KEY, type NoltFake, noltFixtures, startNoltFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { nolt, NOLT_PAGE, NoltError, noltSource, resetNoltPace } from "./nolt";

let fake: NoltFake;
const waits: number[] = [];
const client = (key = FAKE_NOLT_KEY) => nolt(key, Infinity, async (ms) => void waits.push(ms));
const board = (key?: string) => client(key)("NoltBoard", "query NoltBoard { board { id name } }");

beforeAll(async () => {
  fake = await startNoltFake();
});
afterAll(() => fake.close());
afterEach(() => {
  vi.useRealTimers();
  resetNoltPace();
  NOLT_PAGE.commentRequests = 30;
});
beforeEach(() => {
  fake.gone.clear();
  Object.assign(fake, { fixtures: noltFixtures(), pageSize: 50 });
  vi.stubEnv("NOLT_API_URL", fake.env.NOLT_API_URL);
  vi.stubEnv("NOLT_REQUEST_INTERVAL_MS", "0");
  fake.requests.length = 0;
  waits.length = 0;
});

test("requests are a second apart by default, under Nolt's 60 a minute", async () => {
  vi.stubEnv("NOLT_REQUEST_INTERVAL_MS", undefined);
  // A clock that stands still: the pause is the whole second.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
  await board();
  await board();
  expect(waits).toEqual([1000]);
});

test("a key Nolt doesn't know is a refusal (401), though Nolt answers it with a 500, and isn't tried again", async () => {
  const error = await board("wrong").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NoltError);
  expect(error).toMatchObject({ status: 401 });
  expect(waits).toEqual([]);
});

test("a rate limit is waited out (Retry-After), then tried again", async () => {
  fake.failNext(429, 1, { "Retry-After": "2" });
  expect(await board()).toEqual({ board: { id: "nb1", name: "Acme Feedback" } });
  expect(waits).toEqual([2000]);
  expect(fake.requests).toHaveLength(2);
});

test("a comments page reads only so many posts' further comments, and the next goes on from the post it stopped at", async () => {
  fake.pageSize = 1;
  NOLT_PAGE.commentRequests = 1;
  const { read } = noltSource.connect(FAKE_NOLT_KEY, { deadline: Infinity });
  const first = await read.comments!(null);
  // Dark mode (oldest): its comments past the first chunk took the page's one request; CSV export has more too, so it waits.
  expect(first.items.map((comment) => comment.id)).toEqual(["nc2", "nc3"]);
  expect(first.next).toBe("2024-02-01T10:00:00.000Z|np2");
  const second = await read.comments!(first.next);
  expect(second.items.map((comment) => comment.id)).toEqual(["nc6", "nc7"]);
  // The rest have no comments past their first chunk: no more requests, so the page reaches the end.
  expect(second.next).toBeNull();
});

test("looking up several unknown people reads Nolt's users once", async () => {
  const { read } = noltSource.connect(FAKE_NOLT_KEY, { deadline: Infinity });
  await read.contact!("unknown-1");
  await read.contact!("unknown-2");
  expect(fake.requests.filter((request) => request.startsWith("NoltUsers"))).toHaveLength(1);
});

test("a post deleted in Nolt between comments pages moves nothing: the next starts where the last stopped", async () => {
  fake.pageSize = 1;
  NOLT_PAGE.commentRequests = 1;
  const { read } = noltSource.connect(FAKE_NOLT_KEY, { deadline: Infinity });
  const first = await read.comments!(null);
  // Dark mode, done, is deleted: the next page still starts at CSV export, not one post past it.
  fake.fixtures.posts.splice(0, 1);
  expect((await read.comments!(first.next)).items.map((comment) => comment.id)).toEqual(["nc6", "nc7"]);
});

test("a post deleted while its further comments are read keeps what was read and fails nothing", async () => {
  fake.pageSize = 1;
  fake.gone.add("np1");
  const { read } = noltSource.connect(FAKE_NOLT_KEY, { deadline: Infinity });
  // Dark mode's first chunk was its own text: nothing more of it, the rest as ever.
  expect((await read.comments!(null)).items.map((comment) => comment.id)).toEqual(["nc6", "nc7"]);
});
