import { expect, test } from "vitest";

import { retriedByTryAgain } from "./translation-retries";

test("Try again re-queues every customer message whose translation failed, so each says Translating…", () => {
  const message = { author: "USER", note: false, teamText: null, translationError: null };
  expect(
    retriedByTryAgain([
      { ...message, id: "failed-1", translationError: "Out of credits" },
      { ...message, id: "failed-2", translationError: "Couldn't translate it" },
      { ...message, id: "translated", teamText: "Hello" },
      { ...message, id: "untranslated" },
      { ...message, id: "team", author: "TEAM", translationError: "Out of credits" },
      { ...message, id: "note", note: true, translationError: "Out of credits" },
    ]),
  ).toEqual(["failed-1", "failed-2"]);
});
