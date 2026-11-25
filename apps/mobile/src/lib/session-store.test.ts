import { afterEach, describe, expect, it, vi } from "vitest";

import { afterEnded, dueForRecheck, forgetSession, keepSession, readSession, RECHECK_MS, recheckOnForeground, sessionHolds, writeSession } from "./session-store";

const stored = new Map<string, string>();
const store = vi.hoisted(() => ({ failReads: false }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => {
    if (store.failReads) {
      throw new Error("Keychain unavailable");
    }
    return stored.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => void stored.set(key, value),
  deleteItemAsync: async (key: string) => void stored.delete(key),
}));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-web-browser", () => ({}));

const session = { server: "https://tuti.example.com", token: "token-1", cookie: "tuti.session_token=s", project: "acme" };

afterEach(() => {
  stored.clear();
  store.failReads = false;
  vi.unstubAllGlobals();
});

describe("the stored session", () => {
  it("is read back as it was written, and is none once deleted", async () => {
    await writeSession(session);
    expect(await readSession()).toEqual(session);
    await writeSession(null);
    expect(await readSession()).toBeNull();
  });

  it("is none, not an error, when the store can't be read or holds something else", async () => {
    store.failReads = true;
    expect(await readSession()).toBeNull();
    store.failReads = false;
    stored.set("session", "{not json");
    expect(await readSession()).toBeNull();
  });
});

describe("a restored session", () => {
  it("holds unless the server says it ended", async () => {
    const fetch = vi.fn(async () => Response.json({ session: {}, user: {} }));
    vi.stubGlobal("fetch", fetch);
    expect(await sessionHolds(session)).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://tuti.example.com/api/auth/get-session", expect.objectContaining({ headers: expect.objectContaining({ cookie: "tuti.session_token=s" }) }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(null)));
    expect(await sessionHolds(session)).toBe(false);
  });

  it("holds when the server can't be reached or a page that isn't it answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Network request failed");
    }));
    expect(await sessionHolds(session)).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Wi-Fi login</html>", { status: 200 })));
    expect(await sessionHolds(session)).toBe(true);
  });
});

describe("an app left open", () => {
  it("reads its session again twice a day, so a session in daily use never runs out", () => {
    const checked = Date.UTC(2026, 10, 25, 8);
    expect(dueForRecheck(checked, checked + 60_000)).toBe(false);
    expect(dueForRecheck(checked, checked + RECHECK_MS - 1)).toBe(false);
    expect(dueForRecheck(checked, checked + RECHECK_MS)).toBe(true);
    // Better Auth extends a session read a day or more after it was last: twice a day is always in time.
    expect(RECHECK_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });
});

describe("keeping a session", () => {
  it("shows it only once it's stored: a failed write leaves nothing shown", async () => {
    const shown: unknown[] = [];
    await expect(keepSession(session, (next) => shown.push(next), () => Promise.reject(new Error("Keystore unavailable")))).rejects.toThrow("Keystore unavailable");
    expect(shown).toEqual([]);
    await keepSession(session, (next) => shown.push(next), writeSession);
    expect(shown).toEqual([session]);
    expect(await readSession()).toEqual(session);
  });
});

describe("a session found ended", () => {
  it("signs out only if it's still the session in use", () => {
    const newer = { ...session, token: "token-2" };
    expect(afterEnded(session, session)).toBeNull();
    expect(afterEnded(newer, session)).toBe(newer);
    expect(afterEnded(null, session)).toBeNull();
  });

  it("is read again on coming back to the foreground, signed in and due", () => {
    expect(recheckOnForeground("active", true, 0, RECHECK_MS)).toBe(true);
    expect(recheckOnForeground("active", true, 0, RECHECK_MS - 1)).toBe(false);
    expect(recheckOnForeground("background", true, 0, RECHECK_MS)).toBe(false);
    expect(recheckOnForeground("active", false, 0, RECHECK_MS)).toBe(false);
  });
});

describe("signing out", () => {
  it("forgets the session and ends it on the server with its cookie", async () => {
    await writeSession(session);
    const fetch = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await forgetSession();
    expect(await readSession()).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "https://tuti.example.com/api/auth/sign-out",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ cookie: "tuti.session_token=s", "expo-origin": "tuti://" }) }),
    );
  });

  it("leaves a newer session alone when told to forget an older one (a late check or 401)", async () => {
    await writeSession({ ...session, token: "new", cookie: "tuti.session_token=new" });
    const fetch = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await forgetSession(session);
    expect(await readSession()).toMatchObject({ token: "new" });
    expect(fetch).not.toHaveBeenCalled();
    // The one it's told about, it forgets.
    await forgetSession({ ...session, token: "new" });
    expect(await readSession()).toBeNull();
  });

  it("forgets the session even when the server can't be reached", async () => {
    await writeSession(session);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Network request failed");
    }));
    await forgetSession();
    expect(await readSession()).toBeNull();
  });
});
