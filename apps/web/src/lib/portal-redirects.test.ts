import { expect, test } from "vitest";

import { destinationKey, redirectFrom, redirectKey, redirectLocation, redirectTo } from "./portal-redirects";

test("an old address as pasted becomes a path, lowercase and without a trailing slash", () => {
  expect(redirectFrom(" /hc/en-us/Articles/123/ ")).toEqual({ from: "/hc/en-us/articles/123" });
  expect(redirectFrom("https://old.example.com/kb/Billing?x=1")).toEqual({ from: "/kb/billing" });
  for (const bad of ["kb/billing", "//evil.example", "/kb?x=1", "/kb#top", "/a b"]) {
    expect(redirectFrom(bad)).toMatchObject({ error: expect.stringContaining("path") });
  }
  expect(redirectFrom("/")).toMatchObject({ error: expect.stringContaining("Home page") });
  expect(redirectFrom(`/${"a".repeat(600)}`)).toMatchObject({ error: expect.stringContaining("under 500") });
  // A long whole address is refused too, not cut short.
  expect(redirectFrom(`https://old.example.com/${"a".repeat(600)}`)).toMatchObject({ error: expect.stringContaining("under 500") });
  // As requests come in, whether pasted as a path or a whole address: percent-encoded, dot segments resolved.
  expect(redirectFrom("/hc/ja/articles/123-café")).toEqual({ from: "/hc/ja/articles/123-caf%c3%a9" });
  expect(redirectFrom("https://old.example.com/hc/ja/articles/123-café")).toEqual({ from: "/hc/ja/articles/123-caf%c3%a9" });
  expect(redirectFrom("/a/../kb/billing")).toEqual({ from: "/kb/billing" });
  expect(redirectKey(new URL("http://x/hc/ja/articles/123-Café").pathname)).toBe("/hc/ja/articles/123-caf%c3%a9");
});

test("the portal's own addresses can't be redirected", () => {
  for (const own of ["/api/auth/session", "/_tuti/_next/x.js", "/sign-in", "/sso/error", "/widget", "/robots.txt", "/sitemap.xml"]) {
    expect(redirectFrom(own)).toMatchObject({ error: expect.stringContaining("portal's own") });
  }
  // A path that only starts like one is fine.
  expect(redirectFrom("/sign-in-help")).toEqual({ from: "/sign-in-help" });
});

test("a rule sends people to a path of the portal or a whole https address", () => {
  expect(redirectTo("/docs/billing")).toEqual({ to: "/docs/billing" });
  expect(redirectTo("https://acme.example/pricing")).toEqual({ to: "https://acme.example/pricing" });
  for (const bad of ["http://acme.example", "javascript:alert(1)", "//evil.example", "docs/billing", ""]) {
    expect(redirectTo(bad)).toMatchObject({ error: expect.any(String) });
  }
});

test("where a request goes: under the portal's address (and its site's path), with its query unless the rule has one", () => {
  expect(redirectLocation("/docs/billing", "https://acme.tuti.so", "?ref=old")).toBe("https://acme.tuti.so/docs/billing?ref=old");
  expect(redirectLocation("/docs/billing", "https://acme.com/portal", "")).toBe("https://acme.com/portal/docs/billing");
  expect(redirectLocation("https://acme.example/p?plan=pro", "https://acme.tuti.so", "?ref=old")).toBe("https://acme.example/p?plan=pro");
  // The query goes before a fragment.
  expect(redirectLocation("/docs#billing", "https://acme.tuti.so", "?ref=old")).toBe("https://acme.tuti.so/docs?ref=old#billing");
  expect(redirectLocation("/docs?x=1#billing", "https://acme.tuti.so", "?ref=old")).toBe("https://acme.tuti.so/docs?x=1#billing");
});

test("where a rule goes, as rules match it: like an old address, without its query or fragment", () => {
  expect(destinationKey("/A/../Kb/Café/?x=1#top")).toBe("/kb/caf%c3%a9");
  expect(destinationKey("https://acme.example/kb")).toBeNull();
});

test("matching keys: lowercase, trailing slashes gone, quick on a long run of them", () => {
  expect(redirectKey("/KB/Billing///")).toBe("/kb/billing");
  expect(redirectKey("///")).toBe("/");
  expect(redirectKey(`/a${"/".repeat(100_000)}`)).toBe("/a");
});
