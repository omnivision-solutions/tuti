import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { challengeOf, newState, newVerifier } from "./pkce";
import { continueWith, finishSignIn, forgotPasswordUrl, queryOf, readReturn, signInWithPassword } from "./sign-in";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: (algorithm: string, data: Uint8Array) => webcrypto.subtle.digest(algorithm, data),
  getRandomValues: <T extends Uint8Array>(array: T) => webcrypto.getRandomValues(array),
}));
const stored = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void stored.set(key, value),
  deleteItemAsync: async (key: string) => void stored.delete(key),
}));
const browser = vi.hoisted(() => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("expo-web-browser", () => browser);

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
    expect(readReturn({ state: "someone-elses-state-1234", code: "abc" }, state)).toEqual({ error: "That sign-in was started earlier. Try again." });
    expect(readReturn({ state, code: "abc" }, undefined)).toEqual({ error: "That sign-in was started earlier. Try again." });
  });

  it("says why there's no code, in words", () => {
    expect(readReturn({ state, error: "signup_disabled" }, state)).toEqual({
      error: "There's no Tuti account for that address yet. Create one on the web first, then sign in here.",
    });
    expect(readReturn({ state, error: "access_denied" }, state)).toEqual({ error: "Signing in was cancelled." });
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
    await expect(finishSignIn({ state: "older-state-1234567", code: "c" })).rejects.toThrow("That sign-in was started earlier. Try again.");
    expect(stored.has("pending-sign-in")).toBe(true);
  });

  it("does nothing when the screen opens without a way back", async () => {
    expect(await finishSignIn({})).toBeNull();
  });
});

describe("starting a sign-in", () => {
  const pending = () => JSON.parse(stored.get("pending-sign-in")!) as { server: string; state: string; verifier: string };
  const posted = (fetch: ReturnType<typeof vi.fn>, call: number) => {
    const [url, init] = fetch.mock.calls[call]! as [string, RequestInit];
    return { url, headers: init.headers, body: JSON.parse(init.body as string) };
  };

  it("opens Google in the browser sheet through the server's proxy, and exchanges the code it comes back with", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/sign-in/social") ? Response.json({ url: "https://accounts.example.com/auth?a=1&b=2" }) : Response.json({ token: "token-1", cookie: "c" }),
    );
    vi.stubGlobal("fetch", fetch);
    browser.openAuthSessionAsync.mockImplementation(async () => ({ type: "success", url: `tuti://sign-in?state=${pending().state}&code=code-1` }));
    expect(await continueWith("google", "https://tuti.example.com")).toEqual({ server: "https://tuti.example.com", token: "token-1", cookie: "c" });
    const started = posted(fetch, 0);
    expect(started.url).toBe("https://tuti.example.com/api/auth/sign-in/social");
    // `state` and `verifier` were the pending sign-in's; it's used up now.
    expect(started.body).toEqual({ provider: "google", callbackURL: expect.stringMatching(/^tuti:\/\/sign-in\?state=[A-Za-z0-9_-]{22}$/), additionalData: { challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } });
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://tuti.example.com/api/auth/expo-authorization-proxy?authorizationURL=https%3A%2F%2Faccounts.example.com%2Fauth%3Fa%3D1%26b%3D2",
      "tuti://sign-in",
    );
    expect(posted(fetch, 1)).toMatchObject({ url: "https://tuti.example.com/api/auth/app/session", body: { code: "code-1" } });
    expect(stored.has("pending-sign-in")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("is nothing when the teammate closes the browser sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url: "https://accounts.example.com/auth" })));
    browser.openAuthSessionAsync.mockImplementation(async () => ({ type: "cancel" }));
    expect(await continueWith("github", "https://tuti.example.com")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("signing in with a password", () => {
  const answering = (status: number, body: unknown) => vi.fn(async () => Response.json(body, { status }));

  it("posts the email and password with the app's scheme, and keeps the session it answers with", async () => {
    const fetch = answering(200, { token: "token-1", cookie: "tuti.session_token=s" });
    vi.stubGlobal("fetch", fetch);
    expect(await signInWithPassword("https://tuti.example.com", "e2e-olive@example.com", "correct horse")).toEqual({
      server: "https://tuti.example.com",
      token: "token-1",
      cookie: "tuti.session_token=s",
    });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://tuti.example.com/api/auth/app/sign-in/email");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { "expo-origin": "tuti://", "content-type": "application/json" } });
    expect(JSON.parse(init.body as string)).toEqual({ email: "e2e-olive@example.com", password: "correct horse" });
    vi.unstubAllGlobals();
  });

  it("says the same for a wrong password and an unknown address, and asks for an unverified address to be verified", async () => {
    vi.stubGlobal("fetch", answering(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }));
    await expect(signInWithPassword("https://tuti.example.com", "e2e-olive@example.com", "wrong")).rejects.toThrow(
      "That email and password don't match. Try again, or reset your password.",
    );
    vi.stubGlobal("fetch", answering(403, { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }));
    await expect(signInWithPassword("https://tuti.example.com", "e2e-olive@example.com", "right")).rejects.toThrow(
      "Your email address isn't verified yet. Tuti has sent you the verification email again: open its link, then sign in here.",
    );
    // A Tuti server from before the app's password sign-in answers its router's empty 404, and its `ok`.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/auth/ok") ? Response.json({ ok: true }) : new Response(null, { status: 404 }))));
    await expect(signInWithPassword("https://tuti.example.com", "e2e-olive@example.com", "x")).rejects.toThrow(
      "This server doesn't take passwords from the app yet. Continue with Google or GitHub, or ask whoever runs it to update Tuti.",
    );
    // Another site's 404 is the wrong address, not an old Tuti.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Not found</html>", { status: 404 })));
    await expect(signInWithPassword("https://acme.example.com", "e2e-olive@example.com", "x")).rejects.toThrow(
      "acme.example.com didn't answer like a Tuti server (404). Check the address and your connection.",
    );
    // Anything else in the server's words.
    vi.stubGlobal("fetch", answering(429, { code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again later." }));
    await expect(signInWithPassword("https://tuti.example.com", "e2e-olive@example.com", "x")).rejects.toThrow("Too many requests. Please try again later.");
    vi.unstubAllGlobals();
  });

  it("sends Forgot password? to the web's reset on the same server", () => {
    expect(forgotPasswordUrl("https://tuti.example.com")).toBe("https://tuti.example.com/app/auth/forgot-password");
  });
});
