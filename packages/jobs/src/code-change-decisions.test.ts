import { resetCodeChangesSettings } from "@tuti/shared";
import { afterEach, expect, test, vi } from "vitest";

import { confidence, gateResult, namedPosts, postProposal, thresholds } from "./code-change-decisions";

const effect = (probabilities: Record<string, number>) => ({ effect: { type: "choice" as const, choice: "", probabilities } });

test("a post: resolves or moves forward (the likelier) when either passes, else links if it touches it, else nothing", () => {
  expect(postProposal(effect({ resolves: 0.8, moves_forward: 0.1, related: 0.05, unrelated: 0.05 }))).toEqual({ kind: "RESOLVES", probability: 0.8 });
  expect(postProposal(effect({ resolves: 0.42, moves_forward: 0.5, related: 0, unrelated: 0.08 }))).toEqual({ kind: "MOVES_FORWARD", probability: 0.5 });
  expect(postProposal(effect({ resolves: 0.2, moves_forward: 0.2, related: 0.3, unrelated: 0.3 }))).toEqual({ kind: "LINKS", probability: expect.closeTo(0.7) });
  expect(postProposal(effect({ resolves: 0.1, moves_forward: 0.1, related: 0.4, unrelated: 0.4 }))).toBeNull();
});

test("a post: only a kind past its own cutoff wins, when the cutoffs differ", () => {
  vi.stubEnv("CODE_CHANGES_DECISIONS_RESOLVES_MAYBE", "0.7");
  vi.stubEnv("CODE_CHANGES_DECISIONS_MOVES_FORWARD_MAYBE", "0.3");
  resetCodeChangesSettings();
  expect(postProposal(effect({ resolves: 0.6, moves_forward: 0.4, related: 0, unrelated: 0 }))).toEqual({ kind: "MOVES_FORWARD", probability: 0.4 });
  expect(postProposal(effect({ resolves: 0.75, moves_forward: 0.2, related: 0, unrelated: 0.05 }))).toEqual({ kind: "RESOLVES", probability: 0.75 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeChangesSettings();
});

test("likely, maybe and the propose cutoffs follow their settings", () => {
  vi.stubEnv("CODE_CHANGES_DECISIONS_LINKS_LIKELY", "0.8");
  vi.stubEnv("CODE_CHANGES_PROPOSE_EDIT_MAYBE", "0.9");
  vi.stubEnv("CODE_CHANGES_PROPOSE_EDIT_LIKELY", "0.95");
  vi.stubEnv("CODE_CHANGES_PROPOSE_NEW_ARTICLE_MAYBE", "0.1");
  vi.stubEnv("CODE_CHANGES_PROPOSE_NEW_ARTICLE_LIKELY", "0.8");
  resetCodeChangesSettings();
  expect(confidence("LINKS", 0.8)).toBe("likely");
  expect(thresholds()).toMatchObject({ ARTICLE_EDIT: { maybe: 0.9, likely: 0.95 }, NEW_ARTICLE: { maybe: 0.1, likely: 0.8 } });
  expect(confidence("ARTICLE_EDIT", 0.9)).toBe("maybe");
});

test("a post's link follows its cutoff", () => {
  const touching = effect({ resolves: 0.1, moves_forward: 0.1, related: 0.3, unrelated: 0.5 });
  expect(postProposal(touching)).toBeNull();
  vi.stubEnv("CODE_CHANGES_DECISIONS_LINKS_MAYBE", "0.5");
  resetCodeChangesSettings();
  expect(postProposal(touching)).toEqual({ kind: "LINKS", probability: expect.closeTo(0.5) });
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
