import { describe, expect, it, vi } from "vitest";

import { ApiError, authRequest, createApi } from "./api";

const answer = (status: number, body: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe("the API client", () => {
  it("calls /api/v1 as the teammate, in their project, with no cookie jar", async () => {
    const fetch = answer(200, { conversations: [] });
    const api = createApi({ server: "https://tuti.example.com", token: "token-1", project: "acme" }, () => {}, fetch);
    expect(await api("/conversations?view=mine")).toEqual({ conversations: [] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://tuti.example.com/api/v1/conversations?view=mine");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", body: undefined, headers: { authorization: "Bearer token-1", "tuti-project": "acme", accept: "application/json" } });
  });

  it("sends JSON, and no project header before one is chosen", async () => {
    const fetch = answer(200, { ok: true });
    await createApi({ server: "https://tuti.example.com", token: "token-1" }, () => {}, fetch)("/things", { method: "POST", body: { a: 1 } });
    const init = fetch.mock.calls[0]![1]!;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ authorization: "Bearer token-1", accept: "application/json", "content-type": "application/json" });
  });

  it("signs out on a 401, and throws the server's error", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({ server: "https://tuti.example.com", token: "old" }, onUnauthorized, answer(401, { error: { code: "unauthorized", message: "Sign in again" } }));
    await expect(api("/projects")).rejects.toEqual(new ApiError(401, "unauthorized", "Sign in again"));
    await expect(api("/projects")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("keeps the session on other errors", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({ server: "https://tuti.example.com", token: "t" }, onUnauthorized, answer(403, { error: { code: "forbidden", message: "Not in this project" } }));
    await expect(api("/conversations")).rejects.toMatchObject({ status: 403, message: "Not in this project" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("says when the server can't be reached or doesn't answer in JSON", async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(createApi({ server: "https://tuti.example.com", token: "t" }, () => {}, down)("/projects")).rejects.toMatchObject({
      status: 0,
      message: "Couldn't reach tuti.example.com. Check the address and your connection.",
    });
    const html = vi.fn<typeof fetch>(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(createApi({ server: "https://tuti.example.com", token: "t" }, () => {}, html)("/projects")).rejects.toMatchObject({
      status: 502,
      message: "tuti.example.com didn't answer like a Tuti server (502). Check the address and your connection.",
    });
    // A Wi-Fi login page answers 200: that's no answer either (a session check's `null` would sign out).
    const portal = vi.fn<typeof fetch>(async () => new Response("<html>Accept the terms</html>", { status: 200 }));
    await expect(authRequest("https://tuti.example.com", "/get-session", { cookie: "c" }, portal)).rejects.toMatchObject({ code: "not_tuti" });
    expect(await authRequest("https://tuti.example.com", "/get-session", { cookie: "c" }, answer(200, null))).toBeNull();
    const empty = vi.fn<typeof fetch>(async () => new Response("", { status: 500 }));
    await expect(createApi({ server: "https://tuti.example.com", token: "t" }, () => {}, empty)("/projects")).rejects.toMatchObject({ status: 500, code: "not_tuti" });
  });

  it("calls /api/auth with the app's scheme for an origin, and the session's cookie", async () => {
    const fetch = answer(400, { code: "CHALLENGE_REQUIRED", message: "A sign-in from the app comes back to the app and has a challenge." });
    await expect(authRequest("https://tuti.example.com", "/sign-in/social", { body: { provider: "google" }, cookie: "tuti.session_token=x" }, fetch)).rejects.toMatchObject({
      code: "CHALLENGE_REQUIRED",
      message: "A sign-in from the app comes back to the app and has a challenge.",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://tuti.example.com/api/auth/sign-in/social");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { "expo-origin": "tuti://", cookie: "tuti.session_token=x" } });
  });
});
