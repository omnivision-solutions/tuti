import { resetCodeChangesSettings } from "@tuti/shared";
import { afterEach, expect, test, vi } from "vitest";

import { confidence, DECISION_DIFF_CHARS, gateResult, namedPosts, postProposal, postState, pullRequestState, thresholds } from "./code-change-decisions";

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

test("the decision model's copy of the diff: cut before the first file that doesn't fit, and says so", () => {
  const part = (name: string) => `--- src/${name}.ts (modified, +1 -0)\n+${"x".repeat(40)}`;
  const files = ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, status: "modified", additions: 1, deletions: 0 }));
  const pr = { title: "T", body: "", labels: [], author: "", mergedAt: "", mergeCommit: null, commits: [], files, diff: [part("a"), part("b"), part("c")].join("\n") };
  expect(pullRequestState(pr)).toMatchObject({ diff: pr.diff, files: ["src/a.ts (modified)", "src/b.ts (modified)", "src/c.ts (modified)"] });
  expect(pullRequestState(pr, 150)).toMatchObject({
    diff: `${part("a")}\n${part("b")}\n[cut at 150 characters]`,
    files: ["src/a.ts (modified)", "src/b.ts (modified)", "src/c.ts (modified, not shown: size)"],
  });
  // One file bigger than the cap: its start.
  expect(pullRequestState(pr, 30).diff).toBe(`${pr.diff.slice(0, 30)}\n[cut at 30 characters]`);
  // A removed line that starts "--- " (a deleted `-- …` SQL comment) isn't a file's header: the cut is still at one.
  const sql = { ...pr, diff: [part("a"), `${part("b")}\n--- Previous release: safe`, part("c")].join("\n") };
  expect(pullRequestState(sql, 150)).toMatchObject({
    diff: `${part("a")}\n[cut at 150 characters]`,
    files: ["src/a.ts (modified)", "src/b.ts (modified, not shown: size)", "src/c.ts (modified, not shown: size)"],
  });
});

test("a big file crossing the cut far past the last header: its start is shown, not dropped", () => {
  const part = (name: string, size: number) => `--- src/${name}.ts (modified, +1 -0)\n+${"x".repeat(size)}`;
  const files = ["readme", "page"].map((name) => ({ path: `src/${name}.ts`, status: "modified", additions: 1, deletions: 0 }));
  const pr = { title: "T", body: "", labels: [], author: "", mergedAt: "", mergeCommit: null, commits: [], files, diff: [part("readme", 100), part("page", 9_000)].join("\n") };
  const state = pullRequestState(pr, 5_000);
  expect(state.diff).toBe(`${pr.diff.slice(0, 5_000)}\n[cut at 5,000 characters]`);
  expect(state.files).toEqual(["src/readme.ts (modified)", "src/page.ts (modified)"]);
});

test("a diff read at the decision model's size or less (context.diffChars) is left as read, headers and all", () => {
  vi.stubEnv("CODE_CHANGES_CONTEXT_DIFF_CHARS", "1000");
  resetCodeChangesSettings();
  // As readPullRequest leaves it at that cap: each part's text cut to fit, its header on top, so a little over 1,000.
  const part = (name: string, size: number) => `--- src/${name}.ts (modified, +1 -0)\n+${"x".repeat(size)}`;
  const files = ["a", "b"].map((name) => ({ path: `src/${name}.ts`, status: "modified", additions: 1, deletions: 0 }));
  const pr = { title: "T", body: "", labels: [], author: "", mergedAt: "", mergeCommit: null, commits: [], files, diff: [part("a", 600), part("b", 380)].join("\n") };
  expect(pr.diff.length).toBeGreaterThan(1000);
  expect(pullRequestState(pr, 1000)).toMatchObject({ diff: pr.diff, files: ["src/a.ts (modified)", "src/b.ts (modified)"] });
});

test("each post's decision gets the decision model's copy of a big diff, never the whole of it", () => {
  const part = (name: string) => `--- src/${name}.ts (modified, +1 -0)\n+${"x".repeat(DECISION_DIFF_CHARS / 2)}`;
  const files = ["a", "b", "c"].map((name) => ({ path: `src/${name}.ts`, status: "modified", additions: 1, deletions: 0 }));
  const pr = { title: "T", body: "", labels: [], author: "", mergedAt: "", mergeCommit: null, commits: [], files, diff: [part("a"), part("b"), part("c")].join("\n") };
  const state = postState(pr, "Dark mode.", { id: "p", number: 7, title: "Dark mode", body: "Please", status: "OPEN", named: false });
  expect(state.pull_request.diff.length).toBeLessThanOrEqual(DECISION_DIFF_CHARS + 40);
  expect(state.pull_request.diff).toContain(`[cut at ${DECISION_DIFF_CHARS.toLocaleString("en")} characters]`);
  expect(state.pull_request.diff).not.toContain("--- src/c.ts");
  expect(state.pull_request.files).toContain("src/c.ts (modified, not shown: size)");
});
