import { expect, test } from "vitest";

import { postMatches } from "./post-matches";

test("a post's number typed finds it first, even past 50 titles that have the number in them", () => {
  const posts = [...Array.from({ length: 60 }, (_, i) => ({ number: i + 100, title: `Version 1.${i}` })), { number: 1, title: "Dark mode" }];
  expect(postMatches(posts, "#1")[0]).toEqual({ number: 1, title: "Dark mode" });
  expect(postMatches(posts, "#01")[0]).toEqual({ number: 1, title: "Dark mode" });
  expect(postMatches(posts, "1")).toHaveLength(50);
  expect(postMatches(posts, "dark")).toEqual([{ number: 1, title: "Dark mode" }]);
  expect(postMatches(posts, " ")).toHaveLength(50);
});
