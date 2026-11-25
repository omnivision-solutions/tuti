import { expect, test } from "vitest";

import { untickedByDefault } from "./added-pull-requests";

const pr = (number: number, forUsers: boolean | null = null) => ({ repo: "acme/app", number, forUsers });

test("Add changes ticks up to the most one add takes: the rest, and those found nothing for users, start unticked", () => {
  const many = Array.from({ length: 501 }, (_, i) => pr(i + 1));
  expect([...untickedByDefault(many)]).toEqual(["acme/app#501"]);
  // Nothing for users doesn't count toward the most: still 500 ticked.
  expect([...untickedByDefault([pr(1, false), ...many.slice(0, 500)])]).toEqual(["acme/app#1"]);
  expect([...untickedByDefault([pr(1, true), pr(2, false), pr(3)], 1)]).toEqual(["acme/app#2", "acme/app#3"]);
});
