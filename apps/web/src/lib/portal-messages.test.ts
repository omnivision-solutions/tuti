import { LANGUAGE_CODES } from "@tuti/shared/languages";
import { MESSAGES } from "@tuti/shared/messages";
import { createTranslator } from "next-intl";
import { expect, test } from "vitest";

/** Every argument and tag the portal's messages take, with a value. */
const VALUES = {
  count: 2,
  ...Object.fromEntries(["q", "board", "name", "status", "date", "month", "title", "label", "minutes", "forgot", "unit", "votes", "tag", "emoji", "email", "likes", "sort", "language", "limits", "number", "version", "what", "hours", "a", "b", "author"].map((name) => [name, name])),
  ...Object.fromEntries(["link", "who", "status", "entry", "posts", "b", "code", "hidden", "own"].map((tag) => [tag, (chunks: unknown) => chunks])),
  logo: () => "tuti",
};

const paths = (messages: object, prefix = ""): string[] =>
  Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : paths(value, `${prefix}${key}.`)));

test("every message in every language formats (its ICU syntax holds, plurals included)", () => {
  for (const code of LANGUAGE_CODES) {
    const errors: string[] = [];
    const t = createTranslator({ locale: code, messages: MESSAGES[code], onError: (error) => errors.push(error.message) });
    for (const path of paths(MESSAGES[code])) {
      for (const count of [1, 2, 5, 22]) {
        t.rich(path as never, { ...VALUES, count } as never);
      }
    }
    expect(errors, code).toEqual([]);
  }
});
