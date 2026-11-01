#!/usr/bin/env node
// Whether a pull request waits for its review bot (CodeRabbit or Greptile) before it merges
// (.github/workflows/review-risk.yml). High risk waits; low risk merges on green checks and
// Claude's review, and the bot's findings after the merge become an issue (review-late.yml).
// Some paths are always high. A decision model from another family than Claude's reviewer
// judges the rest, so the reviewer's blind spots don't also decide when it's reviewed alone.
//
//   review-risk.mjs <files.json> <pull.diff>   GitHub's file list and diff for the pull request, with
//                                              TITLE, BODY and OPENROUTER_API_KEY in the environment;
//                                              prints {"risk": "high" | "low", "reason": "..."}
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Paths where a missed bug costs the most, whatever the model thinks: these always wait. */
const ALWAYS = [
  // CI, its scripts and the reviewer's prompt, the merge gate (this file and pr-watch's digest),
  // and the rules the reviewers and agents follow.
  [/^\.github\//, "CI or the review gate"],
  [/^\.claude\/skills\/pr-watch\//, "the merge gate"],
  [/^(AGENTS\.md|CLAUDE\.md|\.coderabbit\.yaml|greptile\.json)$/, "the rules reviewers follow"],
  [/^packages\/db\/prisma\//, "the database schema or a migration"],
  // Anywhere in the path, so a folder (portal/.../sso/route.ts) counts; a stray match only means waiting.
  [/(auth|sso|session|api-key|sign-in|password|license-key|signed)/, "sign-in or API keys"],
];
/** What the model reads well at once (as in packages/jobs/src/pull-request.ts); one file's share at most. */
const DIFF_CAP = 20_000;
const FILE_CAP = 6_000;
/** Tests and docs add no risk of their own: the model reads them after the code. */
const TESTS_OR_DOCS = /\.test\.tsx?$|^e2e\/|\.md$|^docs\//;
/**
 * The UI kit, the landing pages and styles: what the model may read only part of, as their mistakes
 * show. Anything else must be read whole to be low: most pages, layouts and components (the
 * marketing group's invitation and licence pages too) are server components that read the
 * database and decide who sees what.
 */
const MAY_CUT = /^apps\/web\/src\/(components\/ui\/|app\/\(marketing\)\/(land-[^/]+\/)?[^/]+$)|\.(css|svg)$/;
export const MODEL = process.env.RISK_MODEL || "typesafe/jev-1.14";
/**
 * At or above it, high. On the pull requests the bots reviewed side by side (#349–#383), every one
 * with a major issue only CodeRabbit found scored over 0.8, and landing pages and layout under 0.25.
 */
export const THRESHOLD = 0.5;

const QUESTION = {
  type: "noul",
  instructions:
    "A pull request to Tuti, a web app where teams collect feedback, plan a roadmap, publish docs and a changelog, and email their users. " +
    "Its checks passed and one AI code review read it. Should a second, independent code review finish before it merges?",
  criteria: {
    true:
      "Yes: it changes what is stored or how (writes, transactions, deletes), who can see or do what, credits or billing, emails or webhooks sent to people, " +
      "background jobs, retries, concurrency or caching, the public API, CI or deployment, or it is large and touches several of these.",
    false:
      "No: copy, styling, layout, docs, tests only, a marketing page, or a small interface change whose worst failure is visible and harmless, " +
      "with no change to stored data, access, emails, jobs or the API.",
  },
};

/** The reason a path alone makes the pull request high risk, if one does. */
export function always(files) {
  // A test changes no behaviour (authorization.db.test.ts isn't sign-in).
  for (const { path } of files.filter((f) => !/\.test\.tsx?$/.test(f.path)))
    for (const [pattern, what] of ALWAYS) if (pattern.test(path)) return `changes ${what} (${path})`;
}

/** The pull request as the model reads it: every file listed, the diff (code first) cut to what it reads well, and the files it cut. */
export function state({ title, body, files, diff }) {
  // The new path (a file moved into the server is server code). Git quotes one with unusual
  // characters; it's left escaped, since only its folders matter here.
  const path = (file) => {
    const header = file.split("\n", 1)[0];
    return header.match(/ "b\/((?:[^"\\]|\\.)*)"$/)?.[1] ?? header.slice(header.lastIndexOf(" b/") + 3);
  };
  const byFile = diff.split(/^(?=diff --git )/m).filter((file) => file.startsWith("diff --git "));
  byFile.sort((a, b) => TESTS_OR_DOCS.test(path(a)) - TESTS_OR_DOCS.test(path(b)));
  let read = "";
  const partlyRead = [];
  for (const file of byFile) {
    const part = file.slice(0, Math.max(0, Math.min(FILE_CAP, DIFF_CAP - read.length)));
    if (part.length < file.length) partlyRead.push(path(file));
    read += part;
  }
  return { title, description: (body ?? "").slice(0, 4_000), files: files.map((f) => `${f.path} +${f.additions} -${f.deletions}`), diff: read, partlyRead };
}

/** Asks the decision model through OpenRouter's Decisions API (as `decide` in @tuti/shared does); the probability of yes. */
async function askModel(pullRequest) {
  const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const response = await fetch(new URL("../alpha/decisions", `${base}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: pullRequest, questions: { review: QUESTION }, provider: { data_collection: "deny" } }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json().catch(() => null);
  const p = json?.answers?.review?.noul;
  if (!response.ok || typeof p !== "number" || p < 0 || p > 1) throw new Error(`${response.status} ${json?.error?.message ?? "no answer"}`);
  return p;
}

/** High or low, and why. Anything that keeps the model from judging is high. */
export async function assess(pullRequest, ask = askModel) {
  const reason = always(pullRequest.files);
  if (reason) return { risk: "high", reason };
  const read = state(pullRequest);
  if (pullRequest.missing) return { risk: "high", reason: "GitHub's diff leaves out some of its files" };
  const unread = read.partlyRead.find((path) => !MAY_CUT.test(path) && !TESTS_OR_DOCS.test(path));
  if (unread) return { risk: "high", reason: `more code than the model reads at once (${unread})` };
  if (!process.env.OPENROUTER_API_KEY && ask === askModel) return { risk: "high", reason: "no OPENROUTER_API_KEY to ask the model" };
  try {
    const p = await ask(read);
    return { risk: p >= THRESHOLD ? "high" : "low", reason: `${MODEL} says ${p.toFixed(2)} (high from ${THRESHOLD})` };
  } catch (error) {
    return { risk: "high", reason: `the model couldn't judge it: ${error.message}` };
  }
}

/**
 * The pull request's files (GitHub's list, every page) and diff as `assess` takes them. A renamed
 * file counts at both paths. Lockfiles are listed, not read: their size says nothing about risk.
 */
export function fromGitHub(gitHubFiles, diff) {
  const files = gitHubFiles.flatMap((f) =>
    [f.filename, f.previous_filename].filter(Boolean).map((path) => ({ path, additions: f.additions, deletions: f.deletions })),
  );
  const byFile = diff.split(/^(?=diff --git )/m).filter((file) => file.startsWith("diff --git "));
  // A diff missing a listed file would hide it from the model: then it can't be low.
  const missing = byFile.length < gitHubFiles.length;
  return { files, diff: byFile.filter((file) => !file.startsWith("diff --git a/pnpm-lock.yaml ")).join(""), missing };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [files, diff] = process.argv.slice(2).map((path) => readFileSync(path, "utf8"));
  const pullRequest = { title: process.env.TITLE ?? "", body: process.env.BODY ?? "", ...fromGitHub(JSON.parse(files), diff) };
  console.log(JSON.stringify(await assess(pullRequest)));
}
