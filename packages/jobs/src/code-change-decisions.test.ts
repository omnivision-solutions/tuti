import { expect, test } from "vitest";

import { articleProposal, confidence, gateResult, namedPosts, newArticleProposal, postProposal } from "./code-change-decisions";

const effect = (probabilities: Record<string, number>) => ({ effect: { type: "choice" as const, choice: "", probabilities } });

test("a post: resolves or moves forward (the likelier) when either passes, else links if it touches it, else nothing", () => {
  expect(postProposal(effect({ resolves: 0.8, moves_forward: 0.1, related: 0.05, unrelated: 0.05 }))).toEqual({ kind: "RESOLVES", probability: 0.8 });
  expect(postProposal(effect({ resolves: 0.42, moves_forward: 0.5, related: 0, unrelated: 0.08 }))).toEqual({ kind: "MOVES_FORWARD", probability: 0.5 });
  expect(postProposal(effect({ resolves: 0.2, moves_forward: 0.2, related: 0.3, unrelated: 0.3 }))).toEqual({ kind: "LINKS", probability: expect.closeTo(0.7) });
  expect(postProposal(effect({ resolves: 0.1, moves_forward: 0.1, related: 0.4, unrelated: 0.4 }))).toBeNull();
});

test("an article: an edit when it's likely wrong or missing something, saying which", () => {
  expect(articleProposal(effect({ wrong: 0.3, missing: 0.5, unaffected: 0.2 }))).toEqual({ probability: 0.8, problem: "missing" });
  expect(articleProposal(effect({ wrong: 0.2, missing: 0.1, unaffected: 0.7 }))).toBeNull();
  expect(newArticleProposal({ needed: { type: "noul", noul: 0.9 } })).toBe(0.9);
  expect(newArticleProposal({ needed: { type: "noul", noul: 0.2 } })).toBeNull();
});

test("the gate's reason is its likeliest other answer", () => {
  const gate = (probabilities: Record<string, number>) => gateResult({ audience: { type: "choice", choice: "", probabilities } });
  expect(gate({ users: 0.1, internal: 0.1, dependencies: 0.7, repository_docs: 0.1 })).toEqual({ users: 0.1, reason: "Dependency updates, with nothing users would notice." });
  expect(gate({ users: 0.9, internal: 0.1, dependencies: 0, repository_docs: 0 }).users).toBe(0.9);
});

test("likely or maybe, by the kind's thresholds", () => {
  expect(confidence("RESOLVES", 0.9)).toBe("likely");
  expect(confidence("RESOLVES", 0.5)).toBe("maybe");
});

test("posts a pull request names: tuti#12, or a post's URL on one of the project's portal addresses", () => {
  const text = [
    "Fixes tuti#12 and TUTI#3, not mytuti#4 or tuti#5x.",
    "See https://acme.tuti.so/feedback/ideas/dark-mode-7 and https://acme.com/portal/feedback/bugs/crash-8.",
    "Not https://acme.tuti.so.evil.com/feedback/ideas/x-9 nor https://other.tuti.so/feedback/ideas/y-10.",
  ].join("\n");
  expect(namedPosts(text, ["https://acme.tuti.so", "https://acme.com/portal"]).sort((a, b) => a - b)).toEqual([3, 7, 8, 12]);
});
