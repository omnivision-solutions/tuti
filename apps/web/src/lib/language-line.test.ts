import { expect, test } from "vitest";

import { languageLine } from "./language-line";

const none = { translated: 0, waiting: 0, why: null };

test("a language's row says its mode, how many of the published pages (articles and changelog entries) have a version, and what waits", () => {
  expect(languageLine({ newPages: "automatic", articles: none, entries: none }, 0)).toBe("Automatic");
  expect(languageLine({ newPages: "automatic", articles: { ...none, translated: 40 }, entries: { ...none, translated: 2 } }, 42)).toBe("Automatic · all 42 pages translated");
  expect(languageLine({ newPages: "automatic", articles: { ...none, translated: 1 }, entries: none }, 1)).toBe("Automatic · 1 page translated");
  expect(languageLine({ newPages: "manual", articles: { ...none, translated: 3 }, entries: none }, 42)).toBe("Manual · 3 of 42 translated");
  // Waiting entries count, and the articles' reason comes first.
  expect(
    languageLine({ newPages: "automatic", articles: { translated: 38, waiting: 1, why: "Out of credits" }, entries: { translated: 1, waiting: 2, why: "The provider didn't answer" } }, 42),
  ).toBe("Automatic · 39 of 42 translated · 3 waiting: Out of credits");
  expect(languageLine({ newPages: "automatic", articles: { ...none, translated: 40 }, entries: { translated: 0, waiting: 2, why: null } }, 42)).toBe("Automatic · 40 of 42 translated · 2 waiting");
});
