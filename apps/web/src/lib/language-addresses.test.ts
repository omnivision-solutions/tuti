import { expect, test } from "vitest";

import { languageFrom, splitLanguage, withLanguage } from "./language-addresses";

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
});

test("a language's prefix is its code in lowercase; the headers proxy.ts sets are read only as one of those", () => {
  expect(splitLanguage("/pt-br/docs")).toEqual({ code: "pt-BR", path: "/docs" });
  expect(splitLanguage("/zh-cn")).toEqual({ code: "zh-CN", path: "/" });
  expect(splitLanguage("/pt-BR/docs")).toBeNull();
  expect(languageFrom(new Headers({ "x-tuti-language": "de", "x-tuti-language-prefix": "/de" }))).toEqual({ language: "de", prefix: "/de" });
  expect(languageFrom(new Headers({ "x-tuti-language": "xx", "x-tuti-language-prefix": "//evil.example" }))).toEqual({ language: null, prefix: "" });
});
