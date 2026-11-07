import { FAKE_INTERCOM_TOKEN, startIntercomFake } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { intercomSource } from "./import-sources/intercom";
import { intercom, IntercomError } from "./intercom";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** fetch answering 401 everywhere but `region`'s address, recording where it was asked. */
function regions(region: string | null) {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      asked.push(url.origin);
      return url.origin === region
        ? Response.json({ type: "admin", id: "1" })
        : Response.json({ type: "error.list", errors: [{ code: "unauthorized", message: "Access Token Invalid" }] }, { status: 401 });
    }),
  );
  return asked;
}

test("a token is tried at each region's address till one takes it, which is then kept; one none takes is refused", async () => {
  const asked = regions("https://api.eu.intercom.io");
  const api = intercom("token");
  await expect(api.get("/me")).resolves.toMatchObject({ id: "1" });
  await api.get("/admins");
  expect(asked).toEqual(["https://api.intercom.io", "https://api.eu.intercom.io", "https://api.eu.intercom.io"]);

  const nowhere = regions(null);
  const error = await intercom("bad").get("/me").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IntercomError);
  expect(error).toMatchObject({ status: 401, message: "Access Token Invalid" });
  expect(nowhere).toEqual(["https://api.intercom.io", "https://api.eu.intercom.io", "https://api.au.intercom.io"]);
});

test("a request rate limited or failing for a while is tried again, waiting as Intercom says; none starts past the deadline", async () => {
  const answers = [
    Response.json({ errors: [{ message: "Too many requests" }] }, { status: 429, headers: { "retry-after": "2" } }),
    new Response("oops", { status: 502 }),
    Response.json({ type: "admin.list", admins: [] }),
  ];
  vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
  const waits: number[] = [];
  await expect(intercom("token", { wait: async (ms) => void waits.push(ms) }).get("/admins")).resolves.toEqual({ type: "admin.list", admins: [] });
  // Retry-After's two seconds, then the first backoff.
  expect(waits).toEqual([2000, 1000]);

  // A wait past the deadline isn't waited, nor tried again: the error comes at once.
  vi.useFakeTimers({ now: new Date("2026-11-07T12:00:00Z"), toFake: ["Date"] });
  const limited = vi.fn(async () => Response.json({ errors: [{ message: "Too many requests" }] }, { status: 429, headers: { "retry-after": "60" } }));
  vi.stubGlobal("fetch", limited);
  waits.length = 0;
  const deadline = Date.parse("2026-11-07T12:00:10Z");
  await expect(intercom("token", { wait: async (ms) => void waits.push(ms), deadline }).get("/admins")).rejects.toMatchObject({ status: 429, message: "Too many requests" });
  expect(waits).toEqual([]);
  expect(limited).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("an article deleted while the list is read (those after it moving up a place) has the whole list read again, so none is missed", async () => {
  const fake = await startIntercomFake();
  try {
    vi.stubEnv("INTERCOM_API_URL", fake.url);
    fake.pageSize = 2;
    const { read } = intercomSource.connect(FAKE_INTERCOM_TOKEN, { deadline: Infinity });
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await read.articles!(cursor, 2);
      ids.push(...page.items.map((a) => a.id));
      cursor = page.next;
      // After the first page, its first article is deleted: the second page starts at the fourth.
      if (++pages === 1) {
        fake.fixtures.articles.shift();
      }
    } while (cursor && pages < 20);
    expect(new Set(ids)).toEqual(new Set(["201", "202", "203", "204"]));
    expect(pages).toBeLessThan(20);
  } finally {
    await fake.close();
  }
});

test("an article created, then another deleted, as the list is read (the count back where it began) still has the whole list read again", async () => {
  const fake = await startIntercomFake();
  try {
    vi.stubEnv("INTERCOM_API_URL", fake.url);
    fake.pageSize = 2;
    const old = fake.fixtures.articles[0]!;
    fake.fixtures.articles = ["A", "B", "C", "D", "E", "F"].map((id, i) => ({ ...old, id, updated_at: 1_700_000_000 - i }));
    const { read } = intercomSource.connect(FAKE_INTERCOM_TOKEN, { deadline: Infinity });
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await read.articles!(cursor, 2);
      ids.push(...page.items.map((a) => a.id));
      cursor = page.next;
      pages++;
      // After the first page, one is made (first in the list); after the second, A is deleted: D moves onto page 2.
      if (pages === 1) {
        fake.fixtures.articles.unshift({ ...old, id: "N", updated_at: fake.clock });
      } else if (pages === 2) {
        fake.fixtures.articles = fake.fixtures.articles.filter((a) => a.id !== "A");
      }
    } while (cursor && pages < 20);
    expect(new Set(ids)).toEqual(new Set(["A", "B", "C", "D", "E", "F", "N"]));
    expect(pages).toBeLessThan(20);
  } finally {
    await fake.close();
  }
});

test("an article edited while a re-read is past its first page still comes: another re-read follows one that needed several pages", async () => {
  const fake = await startIntercomFake();
  try {
    vi.stubEnv("INTERCOM_API_URL", fake.url);
    fake.pageSize = 2;
    const old = fake.fixtures.articles[0]!;
    fake.fixtures.articles = ["301", "302", "303", "304", "305", "306", "307", "308"].map((id, i) => ({ ...old, id, updated_at: 1_700_000_000 - i }));
    /** Edits an article: Intercom lists it first, dated now. */
    const edit = (id: string) => {
      const at = fake.fixtures.articles.findIndex((a) => a.id === id);
      const [edited] = fake.fixtures.articles.splice(at, 1);
      fake.fixtures.articles.unshift({ ...edited, updated_at: fake.clock });
    };
    // What happens after each page is read: 306 edited during the whole pass, 301 and 302 near its end (so the re-read
    // needs two pages), and 306 again while the re-read is on its first page.
    const after: Record<number, () => void> = { 1: () => edit("306"), 3: () => (edit("301"), edit("302")), 5: () => edit("306") };
    const { read } = intercomSource.connect(FAKE_INTERCOM_TOKEN, { deadline: Infinity });
    const ids = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await read.articles!(cursor, 2);
      page.items.forEach((a) => ids.add(a.id));
      cursor = page.next;
      after[++pages]?.();
    } while (cursor && pages < 30);
    expect([...ids].sort()).toEqual(["301", "302", "303", "304", "305", "306", "307", "308"]);
    expect(pages).toBeLessThan(30);
  } finally {
    await fake.close();
  }
});
