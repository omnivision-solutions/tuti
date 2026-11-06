import { expect, test } from "vitest";

import { mergeExposure } from "./visibility-labels";

test("a merge's dialog says when the merged post's comments will be seen by people who couldn't see them", () => {
  const post = (visibility: "PUBLIC" | "PRIVATE" | "TEAM", authorId = "ada") => ({ visibility, authorId });
  expect(mergeExposure(post("PRIVATE"), post("PUBLIC"), 9)).toBe("It's Private: its comments will be seen by everyone who sees #9.");
  expect(mergeExposure(post("TEAM"), post("PRIVATE"), 9)).toBe("It's Team only: its comments will be seen by everyone who sees #9.");
  // Private into another author's Private post: its author sees them.
  expect(mergeExposure(post("PRIVATE", "ada"), post("PRIVATE", "bob"), 9)).toBe("It's Private: its comments will be seen by #9's author too.");
  // As widely seen, or less, by the same people: nothing to say.
  expect(mergeExposure(post("PRIVATE"), post("PRIVATE"), 9)).toBeNull();
  expect(mergeExposure(post("PUBLIC"), post("PRIVATE"), 9)).toBeNull();
  expect(mergeExposure(post("TEAM", "ada"), post("TEAM", "bob"), 9)).toBeNull();
  expect(mergeExposure({}, post("PUBLIC"), 9)).toBeNull();
});
