import { expect, test } from "vitest";

import { languageFrom, portalPathOf, preferredLanguage, splitLanguage, withLanguage } from "./language-addresses";

test("links add the language's prefix back (portalHref, usePortalHref); not to the API, Next.js's files or other sites", () => {
  expect(["/", "/docs/billing", "/?tab=new", "/#top", "/sign-in?next=%2Fdocs"].map((path) => withLanguage("/de", path))).toEqual([
    "/de",
    "/de/docs/billing",
    "/de?tab=new",
    "/de#top",
    "/de/sign-in?next=%2Fdocs",
  ]);
  expect(["/api/widget/live", "/_tuti/_next/x.js", "//evil.example", "https://acme.example", "#comments"].map((path) => withLanguage("/de", path))).toEqual([
    "/api/widget/live",
    "/_tuti/_next/x.js",
    "//evil.example",
    "https://acme.example",
    "#comments",
  ]);
  expect(withLanguage("", "/docs")).toBe("/docs");
  // Already in a language (a `next` to come back to): as it is.
  expect(["/de/docs", "/fr?x=1", "/de"].map((path) => withLanguage("/de", path))).toEqual(["/de/docs", "/fr?x=1", "/de"]);
});

test("a language's prefix is its code in lowercase; the headers proxy.ts sets are read only as one of those", () => {
  expect(splitLanguage("/pt-br/docs")).toEqual({ code: "pt-BR", path: "/docs" });
  expect(splitLanguage("/zh-cn")).toEqual({ code: "zh-CN", path: "/" });
  expect(splitLanguage("/pt-BR/docs")).toBeNull();
  expect(languageFrom(new Headers({ "x-tuti-language": "de", "x-tuti-language-prefix": "/de", "x-tuti-language-default": "en" }))).toEqual({
    language: "de",
    prefix: "/de",
    defaultLanguage: "en",
  });
  expect(languageFrom(new Headers({ "x-tuti-language": "xx", "x-tuti-language-prefix": "//evil.example", "x-tuti-language-default": "yy" }))).toEqual({
    language: null,
    prefix: "",
    defaultLanguage: null,
  });
});

test("the language a browser asks for most, of those offered: whole, else by its first part", () => {
  const offered = ["en", "de", "pt-BR", "zh-CN"] as const;
  expect(preferredLanguage("de-AT,de;q=0.9,en;q=0.8", [...offered])).toBe("de");
  expect(preferredLanguage("fr-FR, en;q=0.5, de;q=0.7", [...offered])).toBe("de");
  expect(preferredLanguage("pt", [...offered])).toBe("pt-BR");
  expect(preferredLanguage("zh-Hans-CN", [...offered])).toBe("zh-CN");
  expect(preferredLanguage("PT-br;q=0.4, en;q=0.4", [...offered])).toBe("pt-BR");
  expect(preferredLanguage("fr, *;q=0.5", [...offered])).toBeNull();
  expect(preferredLanguage("de;q=0, fr", [...offered])).toBeNull();
  expect(preferredLanguage(null, [...offered])).toBeNull();
});

test("a page's portal path (usePortalPath): the site's path and the language's prefix off, whatever the site's path is", () => {
  const acme = { base: "", slug: "acme", prefix: "/de" };
  expect(portalPathOf("/portal/acme/docs/billing", acme)).toBe("/docs/billing");
  expect(portalPathOf("/de/docs/billing", acme)).toBe("/docs/billing");
  expect(portalPathOf("/de", acme)).toBe("/");
  expect(portalPathOf("/help/de/roadmap", { ...acme, base: "/help" })).toBe("/roadmap");
  // A site's path shaped like the internal one (/portal/acme on acme's own site): the prefix comes off too.
  expect(portalPathOf("/portal/acme/de/docs", { ...acme, base: "/portal/acme" })).toBe("/docs");
  // In the default language nothing more comes off.
  expect(portalPathOf("/docs/billing", { ...acme, prefix: "" })).toBe("/docs/billing");
});
