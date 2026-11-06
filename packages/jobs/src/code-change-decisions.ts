import { codeChangesSettings, type DecisionAnswer, type DecisionQuestion } from "@tuti/shared";

import type { PullRequestRead } from "./pull-request";

/**
 * What the decision model is asked about a code change (docs/plan.md, Deciding vs. writing): the gate and the posts,
 * bounded questions answered with probabilities; the writing model only writes for what passes. (The help center's
 * part is the docs agent's, docs-agent.ts.) The evaluation set (code-change-decisions.live.test.ts) asks exactly
 * these, so a new decision model or threshold is measured, not guessed.
 */

/**
 * Per action kind: below `maybe` a proposal is dropped, from it it's proposed as "maybe", and from
 * `likely` as likely ("Apply all" takes those); `gate`, the probability that users see the change,
 * below which there's nothing to do. The server's settings (codeChangesSettings), picked with the
 * evaluation set; per project from its applied and dismissed actions later.
 */
export function thresholds() {
  const { decisions, propose } = codeChangesSettings();
  return {
    gate: decisions.gate,
    RESOLVES: decisions.resolves,
    MOVES_FORWARD: decisions.movesForward,
    LINKS: decisions.links,
    ARTICLE_EDIT: propose.edit,
    NEW_ARTICLE: propose.newArticle,
  };
}

export type ProposedKind = "RESOLVES" | "MOVES_FORWARD" | "LINKS" | "ARTICLE_EDIT" | "NEW_ARTICLE";

/** "likely" or "maybe", by the kind's thresholds. */
export function confidence(kind: ProposedKind, probability: number): "likely" | "maybe" {
  return probability >= thresholds()[kind].likely ? "likely" : "maybe";
}

/** The pull request as the models see it: the decision model with at most `DECISION_DIFF_CHARS` of its diff. */
export function pullRequestState(pr: PullRequestRead, diffChars = Infinity) {
  // Read at or under this size already (`context.diffChars`), it's left as read: its file headers make it a little longer.
  const diff = codeChangesSettings().context.diffChars <= diffChars ? pr.diff : diffUpTo(pr.diff, diffChars, pr.files.map((file) => file.path));
  // A file the cut left out says so, as one past the reading's own cap does.
  const cut = (path: string) => diff !== pr.diff && !`\n${diff}`.includes(`\n--- ${path} (`);
  return {
    title: pr.title,
    labels: pr.labels,
    description: pr.body,
    commits: pr.commits,
    files: pr.files.map((file) => {
      const left = file.left ?? (cut(file.path) ? "size" : undefined);
      return `${file.path} (${file.status}${left ? `, not shown: ${left}` : ""})`;
    }),
    diff,
  };
}

/**
 * How much of the diff the decision model (the gate, the posts) is asked about: it answers best under about 32 KB of
 * text, however much `context.diffChars` lets the docs agent and the writers read.
 */
export const DECISION_DIFF_CHARS = 20_000;

/** The diff up to `max` characters, cut before the first file's part that doesn't fit (each starts "--- path ("). */
/** How much of the room the cut gives up to end at a file's header rather than in the middle of the next file. */
const HEADER_SLACK = 2_000;

function diffUpTo(diff: string, max: number, paths: string[]) {
  if (diff.length <= max) {
    return diff;
  }
  // At a file's own header only: a removed line can start "--- " too (a deleted `-- …` SQL comment, a Markdown rule).
  const header = Math.max(-1, ...paths.map((path) => diff.lastIndexOf(`\n--- ${path} (`, max)));
  // Before the file that doesn't fit, unless that gives up much of the room: then the start of that file instead.
  const end = header > 0 && max - header <= HEADER_SLACK ? header : max;
  return `${diff.slice(0, end)}\n[cut at ${max.toLocaleString("en")} characters]`;
}

export const GATE: Record<string, DecisionQuestion> = {
  audience: {
    type: "choice",
    instructions:
      "Who notices this merged pull request? Users are the people who use the product (in its interface, its API, its emails or its help pages), not the developers who build it.",
    criteria: {
      users: "Users notice it: a new feature, a fix they'd notice, or a change to what they see, read or can do",
      internal: "Only the team building it: refactoring, tests, CI, build, tooling, logging or code style, with nothing users would notice",
      dependencies: "Dependency or version updates, with nothing users would notice",
      repository_docs: "Only the repository's own docs for developers (README, contributing guides, code comments)",
    },
  },
};

/** Why there's nothing to do, by the gate's likeliest other answer. */
export const NOTHING_TO_DO: Record<string, string> = {
  internal: "Only the team sees this: refactoring, tests, CI or tooling.",
  dependencies: "Dependency updates, with nothing users would notice.",
  repository_docs: "Only the repository's own docs changed.",
};

export type GateResult = { users: number; reason: string };

export function gateResult(answers: Record<string, DecisionAnswer>): GateResult {
  const answer = answers.audience as Extract<DecisionAnswer, { type: "choice" }>;
  const { users = 0, ...others } = answer.probabilities;
  const likeliest = Object.entries(others).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "internal";
  return { users, reason: NOTHING_TO_DO[likeliest] ?? NOTHING_TO_DO.internal! };
}

export const POST_QUESTION: Record<string, DecisionQuestion> = {
  effect: {
    type: "choice",
    instructions:
      "What does this merged pull request do for the feedback post (what users asked for)? If the pull request names the post, that's a strong hint, but judge by what it changes.",
    criteria: {
      resolves: "It delivers what the post asks for: the people who asked now have it",
      moves_forward: "Real progress on what the post asks for, but not all of it yet",
      related: "It touches the same part of the product, but doesn't deliver or advance what the post asks for",
      unrelated: "It has nothing to do with the post",
    },
  },
};

export type PostCandidate = { id: string; number: number; title: string; body: string; status: string; named: boolean };

export function postState(pr: PullRequestRead, summary: string, post: PostCandidate) {
  return {
    pull_request: pullRequestState(pr, DECISION_DIFF_CHARS),
    summary_for_users: summary,
    post: { title: post.title, text: post.body.slice(0, 3_000), status: post.status.toLowerCase().replace("_", " ") },
    ...(post.named && { the_pull_request_names_this_post: true }),
  };
}

/** The post's proposal, if any: resolves or moves forward (the likelier of those past their cutoff), else links if it touches it at all. */
export function postProposal(answers: Record<string, DecisionAnswer>): { kind: "RESOLVES" | "MOVES_FORWARD" | "LINKS"; probability: number } | null {
  const { resolves = 0, moves_forward: forward = 0, related = 0 } = (answers.effect as Extract<DecisionAnswer, { type: "choice" }>).probabilities;
  // Only a kind past its own cutoff can win: the cutoffs are settings, so they can differ.
  const resolve = resolves >= thresholds().RESOLVES.maybe;
  const moveForward = forward >= thresholds().MOVES_FORWARD.maybe;
  if (resolve || moveForward) {
    return resolve && (!moveForward || resolves >= forward) ? { kind: "RESOLVES", probability: resolves } : { kind: "MOVES_FORWARD", probability: forward };
  }
  const touches = resolves + forward + related;
  return touches >= thresholds().LINKS.maybe ? { kind: "LINKS", probability: touches } : null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Post numbers a pull request names: `tuti#12` (as its own word), or a post's URL on one of the
 * project's portal addresses (`portals`, e.g. https://acme.tuti.so and https://acme.com/portal), so
 * look-alikes don't count. A signal for the decisions, never a command.
 */
export function namedPosts(text: string, portals: string[]): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?<![\w#/-])tuti#(\d{1,9})(?!\w)/gi)) {
    numbers.add(Number(match[1]));
  }
  for (const address of portals) {
    const portal = new RegExp(`https?://${escapeRegExp(address.replace(/^https?:\/\//, ""))}/feedback/[a-z0-9-]+/(?:[a-z0-9-]*-)?(\\d{1,9})(?![\\w/-]|\\.\\w)`, "gi");
    for (const match of text.matchAll(portal)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers];
}
