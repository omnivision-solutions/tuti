import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { challengeOf, newState, newVerifier } from "./pkce";
import { finishSignIn, queryOf, readReturn } from "./sign-in";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: (algorithm: string, data: Uint8Array) => webcrypto.subtle.digest(algorithm, data),
  getRandomValues: <T extends Uint8Array>(array: T) => webcrypto.getRandomValues(array),
}));
const stored = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  deleteItemAsync: async (key: string) => void stored.delete(key),
}));
vi.mock("expo-web-browser", () => ({}));

describe("PKCE", () => {
  it("makes RFC 7636's challenge from its verifier (appendix B)", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes a new verifier and state each time, in the characters and lengths the server takes", () => {
    const verifier = newVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newVerifier()).not.toBe(verifier);
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe("the way back to the app", () => {
  const state = "Wq5f3Rk9Xa2bN7cD1eF4gH";

  it("takes the code of the sign-in it started", () => {
    expect(readReturn(queryOf(`tuti://sign-in?state=${state}&code=abc%2Bdef`), state)).toEqual({ code: "abc+def" });
  });

  it("takes no code for a state it didn't start, or when it started none", () => {
    expect(readReturn({ state: "someone-elses-state-1234", code: "abc" }, state)).toEqual({ error: expect.stringMatching(/^That link is from an earlier sign-in/) });
    expect(readReturn({ state, code: "abc" }, undefined)).toEqual({ error: expect.stringMatching(/^That link is from an earlier sign-in/) });
  });

  it("says why there's no code, in words", () => {
    expect(readReturn({ state, error: "signup_disabled" }, state)).toEqual({
      error: "There's no Tuti account for that address yet. Create one on the web first, then sign in here.",
    });
    expect(readReturn({ state, error: "INVALID_TOKEN" }, state)).toEqual({ error: "That link has expired or was already used. Ask for a new one." });
    // The server's own words, when it gives them.
    expect(readReturn(queryOf(`tuti://sign-in?state=${state}&error=server_error&error_description=The+provider+is+down`), state)).toEqual({ error: "The provider is down" });
    expect(readReturn({ state, error: "odd" }, state)).toEqual({ error: "Couldn't sign in (odd). Try again." });
    expect(readReturn({ state }, state)).toEqual({ error: "Signing in didn't finish. Try again." });
  });

  it("reads a link's query, skipping what isn't percent-encoded right", () => {
    expect(queryOf("tuti://sign-in?state=a&code=b%20c&bad=%E0%A4%A#frag")).toEqual({ state: "a", code: "b c" });
    expect(queryOf("tuti://sign-in")).toEqual({});
  });
});

describe("finishing a sign-in", () => {
  it("exchanges a code once, with the verifier, at the server that started it, even when the way back arrives twice", async () => {
    stored.set("pending-sign-in", JSON.stringify({ server: "https://tuti.example.com", state: "state-1234567890ab", verifier: "v".repeat(43) }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: "token-1", cookie: "tuti.session_token=s" }));
    vi.stubGlobal("fetch", fetch);
    // On Android the browser sheet's result and the router's link both bring it.
    const [first, second] = await Promise.all([
      finishSignIn({ state: "state-1234567890ab", code: "code-1" }),
      finishSignIn({ state: "state-1234567890ab", code: "code-1" }),
    ]);
    expect(first).toEqual({ server: "https://tuti.example.com", token: "token-1", cookie: "tuti.session_token=s" });
    expect(second).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://tuti.example.com/api/auth/app/session");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ code: "code-1", verifier: "v".repeat(43) });
    // Used up: the same link again does nothing.
    expect(stored.has("pending-sign-in")).toBe(false);
    expect(await finishSignIn({ state: "state-1234567890ab", code: "code-1" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps the latest sign-in when an older link comes back, and says so", async () => {
    stored.set("pending-sign-in", JSON.stringify({ server: "https://tuti.example.com", state: "latest-state-123456", verifier: "v".repeat(43) }));
    await expect(finishSignIn({ state: "older-state-1234567", code: "c" })).rejects.toThrow(/^That link is from an earlier sign-in/);
    expect(stored.has("pending-sign-in")).toBe(true);
  });

  it("does nothing when the screen opens without a way back", async () => {
    expect(await finishSignIn({})).toBeNull();
  });
});
