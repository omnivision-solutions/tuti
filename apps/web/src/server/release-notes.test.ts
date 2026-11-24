import { expect, test } from "vitest";

import { releaseNotesPrompt } from "./release-notes";

const data = (input: Parameters<typeof releaseNotesPrompt>[0]) => {
  const { user } = releaseNotesPrompt(input);
  return JSON.parse(user.slice(user.indexOf("{"))) as { postsItCompletes: { title: string }[]; pullRequests: { ref: string; whatChangedForUsers?: string; completes?: string[] }[] };
};
const pr = (number: number, more: { summary?: string; completes?: string[] } = {}) => ({ title: `Change ${number}`, repo: "acme/app", number, ...more });

test("posts go by votes, and pull requests by their most voted post: those completing none keep the order they merged in, after", () => {
  const sent = data({
    posts: [
      { title: "Few", url: "https://p/few", votes: 1 },
      { title: "None yet", url: "https://p/none", votes: 0 },
      { title: "Many", url: "https://p/many", votes: 9 },
    ],
    pullRequests: [pr(1), pr(2, { completes: ["https://p/none"] }), pr(3, { completes: ["https://p/few", "https://p/many"] }), pr(4), pr(5, { completes: ["https://p/few"] })],
    text: "",
  });
  expect(sent.postsItCompletes.map((post) => post.title)).toEqual(["Many", "Few", "None yet"]);
  // A post nobody voted for yet still comes before no post at all.
  expect(sent.pullRequests.map((each) => each.ref)).toEqual(["acme/app#3", "acme/app#5", "acme/app#2", "acme/app#1", "acme/app#4"]);
  // Only what there is to say: no empty fields.
  expect(sent.pullRequests[3]).toEqual({ title: "Change 1", ref: "acme/app#1" });
});

test("a big release lists every pull request, with the summary of its first 100", () => {
  const sent = data({ posts: [], pullRequests: Array.from({ length: 120 }, (_, i) => pr(i + 1, { summary: `What ${i + 1} changed.` })), text: "" });
  expect(sent.pullRequests).toHaveLength(120);
  expect(sent.pullRequests[99]!.whatChangedForUsers).toBe("What 100 changed.");
  expect(sent.pullRequests[100]).toEqual({ title: "Change 101", ref: "acme/app#101" });
});
