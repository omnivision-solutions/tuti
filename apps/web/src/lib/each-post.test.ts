import { expect, test } from "vitest";

import { eachPost } from "./each-post";

test("each post is done in turn; one that fails, or whose call throws, is said, and the rest still go", async () => {
  const done: number[] = [];
  const failed = await eachPost([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }], async (post) => {
    done.push(post.number);
    if (post.number === 2) {
      throw new Error("network down");
    }
    return post.number === 3 ? { error: "This post was already merged" } : {};
  });
  expect(done).toEqual([1, 2, 3, 4]);
  expect(failed).toEqual(["#2: Couldn't reach Tuti. Try again.", "#3: This post was already merged"]);
});
