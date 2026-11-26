import { expect, test } from "vitest";

import { nativeLanguageName } from "./language-name";

test("a language is named in itself, capitalised; an unknown code stays as it is", () => {
  expect(nativeLanguageName("de")).toBe("Deutsch");
  expect(nativeLanguageName("fr")).toBe("Français");
  expect(nativeLanguageName("en")).toBe("English");
  expect(nativeLanguageName("not a code")).toBe("not a code");
});
