import { beforeEach, describe, expect, it, vi } from "vitest";

import { cached, cacheGeneration, conversationKey, forgetCached, inboxKey, keep, MOST_BYTES, MOST_KEPT, offlineNote, projectsKey, startCache, viewsKey } from "./offline";

// The phone's store, kept across a relaunch (`vi.resetModules`), and a clear that can fail.
const disk = vi.hoisted(() => ({ items: new Map<string, string>(), clearFails: false }));
vi.mock("expo-sqlite/kv-store", () => {
  class SQLiteStorage {
    getItemSync = (key: string) => disk.items.get(key) ?? null;
    setItemSync = (key: string, value: string) => void disk.items.set(key, value);
    removeItemSync = (key: string) => disk.items.delete(key);
    clearSync = () => {
      if (disk.clearFails) {
        throw new Error("disk I/O error");
      }
      disk.items.clear();
      return true;
    };
  }
  return { SQLiteStorage };
});
vi.mock("expo-crypto", () => ({ randomUUID: () => "made-up" }));

const session = { server: "https://tuti.example.com", project: "acme" };
const OWNER = "owner-1";

// Signed in: the cache started for this session.
beforeEach(() => {
  disk.clearFails = false;
  startCache(OWNER);
});

describe("what's kept to read offline", () => {
  it("keeps each list and conversation by server, project and what it is, with when", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration(), OWNER, 1_000);
    keep(conversationKey(session, 12), { subject: "Hi" }, cacheGeneration(), OWNER, 2_000);
    expect(cached(inboxKey(session, "open"), OWNER)).toEqual({ at: 1_000, data: { rows: [1] } });
    expect(cached(inboxKey({ ...session, project: "kite" }, "open"), OWNER)).toBeNull();
    expect(cached(conversationKey(session, 12), OWNER)).toEqual({ at: 2_000, data: { subject: "Hi" } });
  });

  it("keeps the latest written, up to its most, and nothing too big", () => {
    for (let n = 0; n <= MOST_KEPT; n++) {
      keep(conversationKey(session, n), { n }, cacheGeneration(), OWNER);
    }
    // Written again: the latest, so it stays.
    keep(conversationKey(session, 0), { n: 0 }, cacheGeneration(), OWNER);
    keep(conversationKey(session, MOST_KEPT + 1), { n: MOST_KEPT + 1 }, cacheGeneration(), OWNER);
    expect(cached(conversationKey(session, 0), OWNER)).not.toBeNull();
    expect(cached(conversationKey(session, 1), OWNER)).toBeNull();
    expect(cached(conversationKey(session, 2), OWNER)).toBeNull();
    expect(cached(conversationKey(session, 3), OWNER)).not.toBeNull();

    keep(conversationKey(session, 999), { body: "x".repeat(MOST_BYTES) }, cacheGeneration(), OWNER);
    expect(cached(conversationKey(session, 999), OWNER)).toBeNull();
  });

  it("never pushes the projects or a project's counts out for lists and conversations", () => {
    keep(projectsKey(session), [{ slug: "acme" }], cacheGeneration(), OWNER);
    keep(viewsKey(session), [{ view: "open", count: 4 }], cacheGeneration(), OWNER);
    for (let n = 0; n <= MOST_KEPT; n++) {
      keep(conversationKey(session, n), { n }, cacheGeneration(), OWNER);
    }
    expect(cached(projectsKey(session), OWNER)).not.toBeNull();
    expect(cached(viewsKey(session), OWNER)).not.toBeNull();
    expect(cached(conversationKey(session, 0), OWNER)).toBeNull();
  });

  it("forgets everything, and drops what a load that started before then brings", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration(), OWNER);
    const started = cacheGeneration();
    forgetCached();
    expect(cached(inboxKey(session, "open"), OWNER)).toBeNull();
    // Signed in again meanwhile: the load from before still writes nothing.
    startCache(OWNER);
    keep(inboxKey(session, "mine"), { rows: [2] }, started, OWNER);
    expect(cached(inboxKey(session, "mine"), OWNER)).toBeNull();
  });

  it("reads and writes only for the session that owns it: not another's, nor one from before owners", () => {
    keep(inboxKey(session, "open"), { rows: [1] }, cacheGeneration(), OWNER);
    expect(cached(inboxKey(session, "open"), OWNER)?.data).toEqual({ rows: [1] });
    expect(cached(inboxKey(session, "open"), "owner-2")).toBeNull();
    expect(cached(inboxKey(session, "open"), undefined)).toBeNull();

    keep(inboxKey(session, "open"), { rows: [2] }, cacheGeneration(), "owner-2");
    keep(inboxKey(session, "open"), { rows: [3] }, cacheGeneration(), undefined);
    expect(cached(inboxKey(session, "open"), OWNER)?.data).toEqual({ rows: [1] });
  });

  it("reads nothing for a sign-in whose clear failed, after a relaunch too, till a sign-in's clear succeeds", async () => {
    keep(inboxKey(session, "open"), { rows: ["the last account's"] }, cacheGeneration(), OWNER);
    disk.clearFails = true;
    const next = startCache("owner-2");
    expect(cached(inboxKey(session, "open"), next)).toBeNull();

    // The app starts again, the store as it was.
    vi.resetModules();
    const relaunched = await import("./offline");
    expect(relaunched.cached(inboxKey(session, "open"), next)).toBeNull();

    disk.clearFails = false;
    const later = relaunched.startCache("owner-3");
    expect(relaunched.cached(inboxKey(session, "open"), later)).toBeNull();
    relaunched.keep(inboxKey(session, "open"), { rows: ["mine"] }, relaunched.cacheGeneration(), later);
    expect(relaunched.cached(inboxKey(session, "open"), later)?.data).toEqual({ rows: ["mine"] });
  });

  it("gives a sign-in a new owner when it names none", () => {
    expect(startCache()).toBe("made-up");
  });

  it("says it's offline and how long ago it was updated", () => {
    expect(offlineNote(Date.parse("2026-11-25T11:55:00Z"), Date.parse("2026-11-25T12:00:00Z"))).toBe("Offline · updated 5 minutes ago");
  });
});
