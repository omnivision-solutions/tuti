import { FAKE_FERNDESK_KEY, type FerndeskFake, startFerndeskFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { ferndesk, FerndeskError } from "./ferndesk";

let fake: FerndeskFake;
const waits: number[] = [];
const client = (key = FAKE_FERNDESK_KEY, deadline?: number) => ferndesk(key, { wait: async (ms) => void waits.push(ms), deadline });

beforeAll(async () => {
  fake = await startFerndeskFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  vi.stubEnv("FERNDESK_API_URL", fake.url);
  fake.pageSize = 100;
  fake.requests.length = 0;
  waits.length = 0;
});
afterEach(() => vi.restoreAllMocks());

test("a list is read a page at a time, from cursor to cursor, to its end", async () => {
  fake.pageSize = 2;
  const api = client();
  const first = await api.page<{ id: string }>("/collections", null);
  expect(first.items).toHaveLength(2);
  const second = await api.page<{ id: string }>("/collections", first.next);
  // The changelog is listed as a collection too.
  expect(second).toMatchObject({ items: [{ id: "col_start" }, { id: "col_changelog" }], next: null });
  expect(fake.requests[0]).toBe("GET /v1/collections?page_size=100");
  expect(fake.requests[1]).toContain("start_cursor=");
  expect((await api.all<{ id: string }>("/articles")).map((a) => a.id)).toEqual(["art_keys", "art_card", "art_welcome", "art_search", "art_exports"]);
});

const real = globalThis.fetch;
/** Answers the next `times` requests with `status` (and its headers) before Ferndesk does. */
function failNext(status: number, times: number, headers: Record<string, string> = {}) {
  let left = times;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    left-- > 0 ? Promise.resolve(new Response(JSON.stringify({ error: "Slow down" }), { status, headers })) : real(input, init),
  );
}

test("rate limits and server errors are tried again, waiting as Ferndesk says or longer each time; then it gives up, saying so", async () => {
  failNext(429, 2);
  expect(await client().get("/sections")).toMatchObject({ results: [{ name: "Guides" }, { name: "API" }, { name: "Changelog" }] });
  expect(waits).toEqual([500, 1000]);

  waits.length = 0;
  failNext(503, 1, { "retry-after": "3" });
  await client().get("/sections");
  expect(waits).toEqual([3000]);

  failNext(500, 9);
  await expect(client().get("/sections")).rejects.toEqual(new FerndeskError(500, "Slow down"));

  // A wait that would end past its deadline isn't waited: it gives up (the deadline far beyond the test's run, the wait, capped at a minute, further still).
  waits.length = 0;
  failNext(429, 1, { "retry-after": "3600" });
  await expect(client(FAKE_FERNDESK_KEY, Date.now() + 30_000).get("/sections")).rejects.toMatchObject({ status: 429 });
  expect(waits).toEqual([]);
});

test("a key it refuses fails at once, with Ferndesk's reason", async () => {
  await expect(client("fdsk_wrong").get("/articles")).rejects.toEqual(new FerndeskError(401, "Unauthorized"));
  expect(waits).toEqual([]);
});
