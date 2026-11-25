import { describe, expect, it, vi } from "vitest";

import { cached, cacheGeneration, conversationKey, forgetCached, inboxKey, keep, MOST_BYTES, MOST_KEPT, offlineNote, projectsKey, viewsKey } from "./offline";

const clearing = vi.hoisted(() => ({ fails: false }));
vi.mock("expo-sqlite/kv-store", () => {
  const items = new Map<string, string>();
  class SQLiteStorage {
    getItemSync = (key: string) => items.get(key) ?? null;
    setItemSync = (key: string, value: string) => void items.set(key, value);
    removeItemSync = (key: string) => items.delete(key);
    clearSync = () => {
      if (clearing.fails) {
        throw new Error("disk I/O error");
      }
      items.clear();
      return true;
    };
  }
  return { SQLiteStorage };
});

const session = { server: "https://tuti.example.com", project: "acme" };

describe("what's kept to read offline", () => {
  it("keeps each list and conversation by server, project and what it is, with when", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration(), 1_000);
    keep(conversationKey(session, 12), { subject: "Hi" }, cacheGeneration(), 2_000);
    expect(cached(inboxKey(session, "open"))).toEqual({ at: 1_000, data: { rows: [1] } });
    expect(cached(inboxKey({ ...session, project: "kite" }, "open"))).toBeNull();
    expect(cached(conversationKey(session, 12))).toEqual({ at: 2_000, data: { subject: "Hi" } });
  });

  it("keeps the latest written, up to its most, and nothing too big", () => {
    for (let n = 0; n <= MOST_KEPT; n++) {
      keep(conversationKey(session, n), { n }, cacheGeneration());
    }
    // Written again: the latest, so it stays.
    keep(conversationKey(session, 0), { n: 0 }, cacheGeneration());
    keep(conversationKey(session, MOST_KEPT + 1), { n: MOST_KEPT + 1 }, cacheGeneration());
    expect(cached(conversationKey(session, 0))).not.toBeNull();
    expect(cached(conversationKey(session, 1))).toBeNull();
    expect(cached(conversationKey(session, 2))).toBeNull();
    expect(cached(conversationKey(session, 3))).not.toBeNull();

    keep(conversationKey(session, 999), { body: "x".repeat(MOST_BYTES) }, cacheGeneration());
    expect(cached(conversationKey(session, 999))).toBeNull();
  });

  it("never pushes the projects or a project's counts out for lists and conversations", () => {
    keep(projectsKey(session), [{ slug: "acme" }], cacheGeneration());
    keep(viewsKey(session), [{ view: "open", count: 4 }], cacheGeneration());
    for (let n = 0; n <= MOST_KEPT; n++) {
      keep(conversationKey(session, n), { n }, cacheGeneration());
    }
    expect(cached(projectsKey(session))).not.toBeNull();
    expect(cached(viewsKey(session))).not.toBeNull();
    expect(cached(conversationKey(session, 0))).toBeNull();
  });

  it("forgets everything, and drops what a load that started before then brings", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration());
    const started = cacheGeneration();
    forgetCached();
    keep(inboxKey(session, "mine"), { rows: [2] }, started);
    expect(cached(inboxKey(session, "open"))).toBeNull();
    expect(cached(inboxKey(session, "mine"))).toBeNull();
  });

  it("reads nothing after a clear that failed, till one succeeds", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration());
    clearing.fails = true;
    forgetCached();
    expect(cached(inboxKey(session, "open"))).toBeNull();

    clearing.fails = false;
    forgetCached();
    keep(inboxKey(session, "open"), { rows: [2] }, cacheGeneration());
    expect(cached(inboxKey(session, "open"))?.data).toEqual({ rows: [2] });
  });

  it("says it's offline and how long ago it was updated", () => {
    expect(offlineNote(Date.parse("2026-11-25T11:55:00Z"), Date.parse("2026-11-25T12:00:00Z"))).toBe("Offline · updated 5 minutes ago");
  });
});
