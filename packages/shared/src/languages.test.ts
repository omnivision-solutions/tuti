import { readdirSync } from "node:fs";

import { expect, test } from "vitest";

import { LANGUAGE_CODES } from "./languages";
import { MESSAGES } from "./messages";

test("the languages offered are the launch languages, each a canonical language tag", () => {
  expect(LANGUAGE_CODES).toEqual(["en", "de", "fr", "es", "pt-BR", "it", "nl", "ja", "ko", "zh-CN", "pl"]);
  expect(Intl.getCanonicalLocales(LANGUAGE_CODES)).toEqual(LANGUAGE_CODES);
});

/** Each message by its path ("header.signIn"), with the placeholders it takes ("{language}"). */
function flatten(messages: object, prefix = ""): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(messages).flatMap(([key, value]) =>
      typeof value === "string" ? [[`${prefix}${key}`, [...value.matchAll(/\{(\w+)/g)].map((match) => match[1]!).sort()]] : Object.entries(flatten(value, `${prefix}${key}.`)),
    ),
  );
}

test("each language offered has the portal's message file, with every message English has and the same placeholders", () => {
  const files = readdirSync(new URL("./messages", import.meta.url)).filter((file) => file.endsWith(".json"));
  expect(files.map((file) => file.replace(/\.json$/, "")).sort()).toEqual([...LANGUAGE_CODES].sort());
  const english = flatten(MESSAGES.en);
  for (const code of LANGUAGE_CODES) {
    expect(flatten(MESSAGES[code]), code).toEqual(english);
  }
});
