import { expect, test } from "vitest";

import { LANGUAGE_CODES, liveLanguages } from "./languages";

// L4 extends this: each language then needs the portal's message files, with every message English has.
test("the languages offered are the launch languages, each a canonical language tag", () => {
  expect(LANGUAGE_CODES).toEqual(["en", "de", "fr", "es", "pt-BR", "it", "nl", "ja", "ko", "zh-CN", "pl"]);
  expect(Intl.getCanonicalLocales(LANGUAGE_CODES)).toEqual(LANGUAGE_CODES);
});

test("live languages: those set live, only the oldest within the plan's limit (the default counts), codes no longer offered left out", () => {
  const languages = [{ code: "de", live: true }, { code: "xx", live: true }, { code: "fr", live: false }, { code: "es", live: true }];
  expect(liveLanguages(languages, null)).toEqual(["de", "es"]);
  expect(liveLanguages(languages, 3)).toEqual(["de"]);
  expect(liveLanguages(languages, 4)).toEqual(["de", "es"]);
  expect(liveLanguages(languages, 1)).toEqual([]);
});
