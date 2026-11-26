import { expect, test } from "vitest";

import { composerTranslation } from "./conversation-translation";

const on = { teamLanguage: "en", translate: true };

test("replies are translated where the project translates, the server has AI, and the customer's language is known and not the team's", () => {
  expect(composerTranslation(on, "de", true)).toEqual({ language: "de", teamLanguage: "en" });
  // Without AI on the server: replies go as written, no preview box.
  expect(composerTranslation(on, "de", false)).toBeUndefined();
  expect(composerTranslation({ ...on, translate: false }, "de", true)).toBeUndefined();
  expect(composerTranslation(on, null, true)).toBeUndefined();
  expect(composerTranslation(on, "en-GB", true)).toBeUndefined();
});
