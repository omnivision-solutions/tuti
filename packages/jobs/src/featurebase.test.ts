import { FAKE_FEATUREBASE_KEY, type FeaturebaseFake, startFeaturebaseFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { featurebase, FeaturebaseError } from "./featurebase";
import { contactDetails } from "./imports";

let fake: FeaturebaseFake;
const waits: number[] = [];
const client = (key = FAKE_FEATUREBASE_KEY) => featurebase(key, { wait: async (ms) => void waits.push(ms) });

beforeAll(async () => {
  fake = await startFeaturebaseFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  vi.stubEnv("FEATUREBASE_API_URL", fake.env.FEATUREBASE_API_URL);
  fake.pageSize = 100;
  fake.requests.length = 0;
  waits.length = 0;
});

test("a list is read a page at a time, from cursor to cursor, its empty rows left out", async () => {
  fake.pageSize = 2;
  const api = client();
  const first = await api.page<{ id: string }>("/contacts", null, { contactType: "all" });
  expect(first.items.map((c) => c.id)).toEqual(["65f000000000000000000001", "65f000000000000000000002"]);
  const second = await api.page<{ id: string }>("/contacts", first.next, { contactType: "all" });
  // The page's null row is left out.
  expect(second.items.map((c) => c.id)).toEqual(["65f000000000000000000003"]);
  expect(second.next).toBeNull();
  expect(fake.requests[0]).toBe("GET /v2/contacts?contactType=all&limit=100");
  expect(fake.requests[1]).toContain("cursor=");
});

test("rate limits and server errors are tried again, waiting longer each time; then it gives up, saying so", async () => {
  fake.failNext(429, 2);
  expect((await client().get<{ data: unknown[] }>("/admins")).data).toHaveLength(2);
  expect(waits).toEqual([500, 1000]);

  waits.length = 0;
  fake.failNext(500, 5);
  const error = await client().get("/admins").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(FeaturebaseError);
  expect(error).toMatchObject({ status: 500, message: "fake failure" });
  expect(waits).toEqual([500, 1000, 2000, 4000]);
});

test("a wait Featurebase asks for is honoured, up to a minute: Retry-After in seconds, or a rate limit's reset (epoch seconds) on 429", async () => {
  // Only the clock is faked: the requests still go out.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // As a live answer had it: x-ratelimit-limit 2000, the window resetting at 1793918026 (2026-11-05), 20 seconds on.
    const reset = 1793918026;
    vi.setSystemTime((reset - 20) * 1000);
    fake.failNext(429, 1, { "retry-after": "30" });
    await client().get("/admins");
    fake.failNext(429, 1, { "retry-after": "120" });
    await client().get("/admins");
    fake.failNext(429, 1, { "x-ratelimit-limit": "2000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    await client().get("/admins");
    // A reset long away waits a minute at most; one that has passed, not at all.
    fake.failNext(429, 1, { "x-ratelimit-reset": String(reset + 3600) });
    await client().get("/admins");
    fake.failNext(429, 1, { "x-ratelimit-reset": String(reset - 60) });
    await client().get("/admins");
    // A server error's reset isn't a rate limit's: the usual backoff.
    fake.failNext(503, 1, { "x-ratelimit-reset": String(reset) });
    await client().get("/admins");
    expect(waits).toEqual([30_000, 60_000, 20_000, 60_000, 0, 500]);
  } finally {
    vi.useRealTimers();
  }
});

test("a key Featurebase refuses fails at once, with Featurebase's words; so does a part it can't read", async () => {
  await expect(client("sk_wrong").get("/admins")).rejects.toMatchObject({ status: 401, message: "Invalid API key" });
  fake.forbidden.add("/v2/contacts");
  await expect(client().get("/contacts", { limit: 1 })).rejects.toMatchObject({ status: 403 });
  await expect(client().get("/contacts/65f000000000000000000001")).rejects.toMatchObject({ status: 403 });
  expect(waits).toEqual([]);
});

test("a contact becomes a user: their app's id (else Featurebase's), details they have, properties Tuti takes, their first company", () => {
  expect(
    contactDetails({
      id: "c1",
      userId: "app-1",
      name: " Mira ",
      email: "e2e-mira@example.com",
      profilePicture: "https://images.example.com/mira.png",
      customFields: { plan: "pro", seats: 12, beta: true, features: ["sso"], nested: { no: true }, mixed: ["a", 1], long: "x".repeat(201), gone: null, company: "Theirs" },
      companies: [{ name: "Fenwick Labs" }, { name: "Side Gig" }],
    }),
  ).toEqual({
    externalId: "app-1",
    name: "Mira",
    email: "e2e-mira@example.com",
    image: "https://images.example.com/mira.png",
    properties: { company: "Fenwick Labs", plan: "pro", seats: 12, beta: true, features: ["sso"] },
  });
  // Nothing of their own: Featurebase's id, and only what they have (Featurebase's placeholder avatar isn't theirs).
  expect(contactDetails({ id: "c2", userId: null, name: "", email: null, profilePicture: "https://global.featurebase-attachments.com/a/shapes/3_200_200.png", companies: [] })).toEqual({
    externalId: "featurebase:c2",
    name: undefined,
    email: undefined,
    image: undefined,
    properties: {},
  });
});
