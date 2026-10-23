import type { DecisionAnswer, DecisionQuestion } from "@tuti/shared";

import type { PullRequestRead } from "./pull-request";

/**
 * What the decision model is asked about a code change (docs/plan.md, Deciding vs. writing): bounded
 * questions, answered with probabilities; the writing model only writes for what passes. The
 * evaluation set (code-change-decisions.live.test.ts) asks exactly these, so a new decision model or
 * threshold is measured, not guessed.
 */

/**
 * Per action kind: below `maybe` a proposal is dropped, from it it's proposed as "maybe", and from
 * `likely` as likely ("Apply all" takes those). ponytail: one set for every project, picked with the
 * evaluation set; per project from its applied and dismissed actions later.
 */
export const THRESHOLDS = {
  /** The gate: the probability that users see the change. Below it, there's nothing to do. */
  gate: 0.5,
  RESOLVES: { maybe: 0.4, likely: 0.75 },
  MOVES_FORWARD: { maybe: 0.4, likely: 0.75 },
  LINKS: { maybe: 0.65, likely: 0.85 },
  ARTICLE_EDIT: { maybe: 0.4, likely: 0.75 },
  NEW_ARTICLE: { maybe: 0.5, likely: 0.8 },
} as const;

export type ProposedKind = "RESOLVES" | "MOVES_FORWARD" | "LINKS" | "ARTICLE_EDIT" | "NEW_ARTICLE";

/** "likely" or "maybe", by the kind's thresholds. */
export function confidence(kind: ProposedKind, probability: number): "likely" | "maybe" {
  return probability >= THRESHOLDS[kind].likely ? "likely" : "maybe";
}

/** The pull request as the decision model sees it. */
export function pullRequestState(pr: PullRequestRead) {
  return {
    title: pr.title,
    labels: pr.labels,
    description: pr.body,
    commits: pr.commits,
    files: pr.files.map((file) => `${file.path} (${file.status}${file.left ? `, not shown: ${file.left}` : ""})`),
    diff: pr.diff,
  };
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
    pull_request: pullRequestState(pr),
    summary_for_users: summary,
    post: { title: post.title, text: post.body.slice(0, 3_000), status: post.status.toLowerCase().replace("_", " ") },
    ...(post.named && { the_pull_request_names_this_post: true }),
  };
}

/** The post's proposal, if any: resolves or moves forward (the likelier, if either passes), else links if it touches it at all. */
export function postProposal(answers: Record<string, DecisionAnswer>): { kind: "RESOLVES" | "MOVES_FORWARD" | "LINKS"; probability: number } | null {
  const { resolves = 0, moves_forward: forward = 0, related = 0 } = (answers.effect as Extract<DecisionAnswer, { type: "choice" }>).probabilities;
  if (resolves >= THRESHOLDS.RESOLVES.maybe || forward >= THRESHOLDS.MOVES_FORWARD.maybe) {
    return resolves >= forward ? { kind: "RESOLVES", probability: resolves } : { kind: "MOVES_FORWARD", probability: forward };
  }
  const touches = resolves + forward + related;
  return touches >= THRESHOLDS.LINKS.maybe ? { kind: "LINKS", probability: touches } : null;
}

export const ARTICLE_QUESTION: Record<string, DecisionQuestion> = {
  effect: {
    type: "choice",
    instructions: "After this merged pull request, is the help article still right and complete for users?",
    criteria: {
      wrong: "Something the article says is no longer true, or a step no longer works as written",
      missing: "It's still true, but it should now cover something the pull request adds or changes",
      unaffected: "The article doesn't need to change",
    },
  },
};

export type ArticleCandidate = { id: string; title: string; body: string };

export function articleState(pr: PullRequestRead, summary: string, article: ArticleCandidate) {
  return { pull_request: pullRequestState(pr), summary_for_users: summary, article: { title: article.title, text: article.body.slice(0, 6_000) } };
}

/** The article's proposal, if any: an edit, because it's now wrong or missing something (the likelier). */
export function articleProposal(answers: Record<string, DecisionAnswer>): { probability: number; problem: "wrong" | "missing" } | null {
  const { wrong = 0, missing = 0 } = (answers.effect as Extract<DecisionAnswer, { type: "choice" }>).probabilities;
  const probability = wrong + missing;
  return probability >= THRESHOLDS.ARTICLE_EDIT.maybe ? { probability, problem: wrong >= missing ? "wrong" : "missing" } : null;
}

export const NEW_ARTICLE_QUESTION: Record<string, DecisionQuestion> = {
  needed: {
    type: "noul",
    instructions:
      "Does this merged pull request let users do something new that none of the existing help articles listed covers, so the help center needs a new article?",
    criteria: {
      true: "Users can now do something new, worth explaining, that no listed article covers",
      false: "Nothing new to explain, or a listed article covers it (or could, with an edit)",
    },
  },
};

export function newArticleState(pr: PullRequestRead, summary: string, articles: ArticleCandidate[]) {
  return { pull_request: pullRequestState(pr), summary_for_users: summary, existing_articles: articles.map((article) => article.title) };
}

export function newArticleProposal(answers: Record<string, DecisionAnswer>): number | null {
  const probability = (answers.needed as Extract<DecisionAnswer, { type: "noul" }>).noul;
  return probability >= THRESHOLDS.NEW_ARTICLE.maybe ? probability : null;
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
