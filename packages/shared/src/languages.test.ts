import { expect, test } from "vitest";

import { LANGUAGE_CODES } from "./languages";

// L4 extends this: each language then needs the portal's message files, with every message English has.
test("the languages offered are the launch languages, each a canonical language tag", () => {
  expect(LANGUAGE_CODES).toEqual(["en", "de", "fr", "es", "pt-BR", "it", "nl", "ja", "ko", "zh-CN", "pl"]);
  expect(Intl.getCanonicalLocales(LANGUAGE_CODES)).toEqual(LANGUAGE_CODES);
});
