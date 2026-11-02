import { expect, test } from "vitest";

import { linkParts } from "./message-links";

const links = (text: string) => linkParts(text).filter((_, i) => i % 2 === 1);

test("finds http and https addresses, and the text stays whole", () => {
  const text = "Read Setting up SSO: https://acme.tuti.so/docs/sso then http://example.com/a?b=1#c";
  expect(links(text)).toEqual(["https://acme.tuti.so/docs/sso", "http://example.com/a?b=1#c"]);
  expect(linkParts(text).join("")).toBe(text);
});

test("punctuation after an address isn't part of it", () => {
  expect(links("See https://example.com/a. Or https://example.com/b, or https://example.com/c!")).toEqual([
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
  expect(links('"https://example.com/q"')).toEqual(["https://example.com/q"]);
  expect(links("Is “https://example.com/pricing” right? See https://example.com/r… or https://example.com/s’")).toEqual([
    "https://example.com/pricing",
    "https://example.com/r",
    "https://example.com/s",
  ]);
});

test("a bracket it didn't open ends it; its own stay", () => {
  expect(links("(see https://example.com/a)")).toEqual(["https://example.com/a"]);
  expect(links("[https://example.com/b]")).toEqual(["https://example.com/b"]);
  expect(links("(https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  expect(links("<https://example.com/c>")).toEqual(["https://example.com/c"]);
});

test("other schemes and bare words stay text", () => {
  expect(linkParts("javascript:alert(1) data:text/html,hi ftp://example.com example.com https://")).toEqual([
    "javascript:alert(1) data:text/html,hi ftp://example.com example.com https://",
  ]);
  expect(links("xhttps://example.com")).toEqual([]);
});

// Trimming a bracket at a time took minutes on the longest: Vitest's timeout fails it.
test("a huge run of brackets after an address is quick, and an address longer than browsers keep stays text", () => {
  expect(links(`https://example.com/a${")".repeat(2000)}`)).toEqual(["https://example.com/a"]);
  expect(links(`https://example.com/${")".repeat(200_000)}`)).toEqual([]);
});
