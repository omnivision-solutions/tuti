import { readdirSync } from "node:fs";

import { expect, test } from "vitest";

import { LANGUAGE_CODES, liveLanguages } from "./languages";
import { MESSAGES } from "./messages";

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

/**
 * A message's arguments ("{language}", "{count, plural, …}": count) and rich-text tags ("<link>"). Only the outermost braces
 * name arguments: inside a plural's branches ("one {vote}") are a language's own words.
 */
function placeholders(message: string): string[] {
  const found: string[] = [];
  let depth = 0;
  for (const [token, name, tag] of message.matchAll(/\{(\w+)?|\}|<(\w+)>/g)) {
    if (token === "}") {
      depth--;
    } else if (tag) {
      found.push(`<${tag}>`);
    } else {
      if (depth === 0 && name) {
        found.push(name);
      }
      depth++;
    }
  }
  return found.sort();
}

/** Each message by its path ("header.signIn"), with the placeholders it takes ("{language}"). */
function flatten(messages: object, prefix = ""): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(messages).flatMap(([key, value]) =>
      typeof value === "string" ? [[`${prefix}${key}`, placeholders(value)]] : Object.entries(flatten(value, `${prefix}${key}.`)),
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
