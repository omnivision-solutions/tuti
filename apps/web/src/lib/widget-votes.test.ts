import { expect, test } from "vitest";

import { type KnownVotes, withAnswer } from "./widget-votes";

const none: KnownVotes = { identity: "ada", ideas: {} };

test("a list sent before a vote and back after it doesn't undo the vote; a list sent after it does replace it", () => {
  // The list asked at 1, the vote back at 2, then the list's answer (from before the vote) comes.
  const voted = withAnswer(none, "ada", "ada", [{ id: "p1", voteCount: 6, voted: true }], 2);
  const stale = withAnswer(voted, "ada", "ada", [{ id: "p1", voteCount: 5, voted: false }, { id: "p2", voteCount: 1, voted: false }], 1);
  expect(stale.ideas).toEqual({ p1: { voteCount: 6, voted: true, at: 2 }, p2: { voteCount: 1, voted: false, at: 1 } });
  // A list asked after the vote (someone else voted too) is the newest word.
  expect(withAnswer(stale, "ada", "ada", [{ id: "p1", voteCount: 7, voted: true }], 3).ideas.p1).toEqual({ voteCount: 7, voted: true, at: 3 });
});

test("an answer for someone who's gone isn't kept; someone new starts with none", () => {
  const ada = withAnswer(none, "ada", "ada", [{ id: "p1", voteCount: 6, voted: true }], 2);
  expect(withAnswer(ada, "bo", "ada", [{ id: "p2", voteCount: 1, voted: true }], 3)).toBe(ada);
  expect(withAnswer(ada, "bo", "bo", [{ id: "p2", voteCount: 1, voted: true }], 1)).toEqual({ identity: "bo", ideas: { p2: { voteCount: 1, voted: true, at: 1 } } });
});
