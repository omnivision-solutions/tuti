import { expect, test } from "vitest";

import { readerLanguage } from "./reader-language";

const languages = { default: "en" as const, live: ["de" as const, "fr" as const] };

test("the browser's choice first, then a signed-in reader's saved one, else the portal's default", () => {
  expect(readerLanguage(languages, ["fr", "de"])).toBe("fr");
  expect(readerLanguage(languages, [undefined, "de"])).toBe("de");
  expect(readerLanguage(languages, [undefined, null])).toBe("en");
  expect(readerLanguage(languages, ["en", "de"])).toBe("en");
});

test("only a live language or the default: one offline, removed or never offered falls back", () => {
  expect(readerLanguage(languages, ["es", "de"])).toBe("de");
  expect(readerLanguage(languages, ["es"])).toBe("en");
  expect(readerLanguage(languages, ["xx", "constructor"])).toBe("en");
  expect(readerLanguage({ default: "de", live: [] }, ["en"])).toBe("de");
});
