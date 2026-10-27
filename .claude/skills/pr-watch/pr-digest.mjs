#!/usr/bin/env node
// Collapses a pull request's checks, review bot and review comments into a few
// lines and a VERDICT, applying the merge gate in SKILL.md. Ported from
// https://github.com/elie222/rakazo (.agents/skills/pr-watch/pr-digest).
//
//   pr-digest.mjs [PR]          one observation of the PR's head commit
//   pr-digest.mjs --watch [PR]  wait until nothing is pending or something new needs an answer
//
// Exit: 0 green · 10 failures · 11 open-comments · 12 pending · 13 no-bot · 20 out-of-sync · 1 error
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The label .github/workflows/review-bot.yml puts on a PR, and the check (or status) its bot posts.
const BOTS = { "review:coderabbit": "CodeRabbit", "review:greptile": "Greptile Review" };
// Paths SKILL.md's reviewed-commit exception lets change after the bot's review.
const TESTS_OR_DOCS = /\.md$|^docs\/|^e2e\/|\.test\.tsx?$/;
const PASSED = ["success", "neutral", "skipped"];
const EXIT = { green: 0, failures: 10, "open-comments": 11, pending: 12, "no-bot": 13, "out-of-sync": 20 };

/** The bot's result on one commit: success, pending, missing, or the failing conclusion. */
export function botState(name, runs, statuses) {
  const run = runs.find((r) => r.name === name);
  if (run) return run.status !== "completed" ? "pending" : PASSED.includes(run.conclusion) ? "success" : run.conclusion;
  return statuses.find((s) => s.context === name)?.state ?? "missing";
}

// Status chrome, not findings: CodeRabbit's walkthrough, Greptile's summary and
// lockout notice, the E2E screenshots comment (scripts/publish-screenshots.sh).
function isNoise({ user, body }) {
  if (user.type !== "Bot") return false;
  if (user.login === "coderabbitai[bot]")
    return /^(<!-- coderabbit-ai-generated:v1 -->\s*)?<!-- This is an auto-generated comment: (summarize|rate limited) by coderabbit\.ai -->/.test(body);
  if (user.login === "greptile-apps[bot]")
    return /^(<h3>Greptile Summary<\/h3>|<!-- greptile_summary -->)/.test(body) || body.includes("Reactivate Greptile");
  if (user.login === "github-actions[bot]") return body.startsWith("<!-- tuti-e2e-screenshots -->");
  return false;
}

// Bots pad bodies with HTML comments, collapsed sections and badges; the prose around them is the finding.
function clean(body) {
  let text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  for (let i = 0; i < 6; i++) text = text.replace(/<details>(?:(?!<details>)[\s\S])*?<\/details>/g, "");
  return text
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ")
    .trim()
    .slice(0, 400);
}

const links = (body) => (body.match(/https?:\/\/[^\s<>"()[\]]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ""));

/**
 * Applies the merge gate to one observation of the PR's head. `earlier` is the
 * newest earlier commit the bot passed on ({ sha, files } changed since), given
 * only when the bot hasn't passed on the head.
 */
export function digest({ pr, viewer, local, headMoved, runs, statuses, threads, inline, conversation, reviews, earlier }) {
  const head = pr.headRefOid;
  const lines = [`PR #${pr.number} · ${pr.headRefName} · ${pr.mergeable} · head ${head.slice(0, 8)}`];
  if (pr.state !== "OPEN") return { lines: [...lines, `VERDICT ${pr.state.toLowerCase()}`], verdict: pr.state.toLowerCase(), keys: [], pending: 0 };

  const sync = [];
  if (headMoved) sync.push("the head moved during this observation");
  if (local && (local.sha !== head || (local.upstream && local.upstream !== head)))
    sync.push(`local ${local.sha.slice(0, 8)}, upstream ${local.upstream.slice(0, 8) || "none"}, PR ${head.slice(0, 8)}`);
  if (pr.mergeable === "CONFLICTING") sync.push("conflicts with the base branch: rebase");
  for (const reason of sync) lines.push(`OUT OF SYNC ${reason}`);

  const failed = [
    ...runs.filter((r) => r.status === "completed" && !PASSED.includes(r.conclusion)).map((r) => `${r.name} [${r.conclusion}] ${r.html_url}`),
    ...statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => `${s.context} [${s.state}] ${s.target_url ?? ""}`),
  ];
  const pending = [...runs.filter((r) => r.status !== "completed").map((r) => r.name), ...statuses.filter((s) => s.state === "pending").map((s) => s.context)];
  // Right after a push nothing has registered yet: that's not a pass.
  if (runs.length === 0) pending.push("(no checks yet)");
  const counts = {};
  for (const r of runs) counts[r.conclusion ?? "pending"] = (counts[r.conclusion ?? "pending"] ?? 0) + 1;
  lines.push(`checks ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ") || "none"}`);
  for (const f of failed) lines.push(`FAIL ${f}`);
  if (pending.length) lines.push(`PENDING ${pending.join(", ")}`);

  // A missing bot status is not a pass: the PR's bot must have passed on the head, or on
  // an earlier commit with only tests and docs changed since.
  const label = pr.labels.map((l) => l.name).find((name) => name in BOTS);
  const bot = BOTS[label];
  const state = bot && botState(bot, runs, statuses);
  if (!bot) lines.push("BOT none: no review:coderabbit or review:greptile label, so no bot reviews this PR. Add one");
  else if (state === "success") lines.push(`BOT ${bot}: passed on the head`);
  else if (state !== "pending" && state !== "missing") lines.push(`BOT ${bot}: ${state} on the head`);
  else if (earlier && earlier.files.every((f) => TESTS_OR_DOCS.test(f)))
    lines.push(`BOT ${bot}: passed on ${earlier.sha.slice(0, 8)}; only tests and docs changed since`);
  else {
    pending.push(bot);
    const code = earlier?.files.filter((f) => !TESTS_OR_DOCS.test(f));
    lines.push(
      `BOT ${bot}: ${state} on the head` +
        (earlier
          ? `. Passed on ${earlier.sha.slice(0, 8)}; changed since: ${code.join(", ")}. If those changes are comments only, it counts as reviewed (SKILL.md)`
          : ""),
    );
  }

  const findings = [];
  // Inline comments: answered by your reply after the root's latest edit, and the thread resolved.
  const unresolved = new Map(threads.filter((t) => !t.isResolved).map((t) => [t.comments.nodes[0]?.databaseId, t.id]));
  const replies = inline.filter((c) => c.in_reply_to_id && c.user.login === viewer);
  for (const c of inline.filter((c) => !c.in_reply_to_id)) {
    // Bots edit their roots for bookkeeping ("Addressed in commit", reply markers); only a person's edit reopens.
    const since = c.user.type === "Bot" ? c.created_at : c.updated_at;
    const unanswered = c.user.login !== viewer && !replies.some((r) => r.in_reply_to_id === c.id && r.created_at > since);
    const thread = unresolved.get(c.id);
    if (unanswered || thread)
      findings.push({
        key: `${c.id}:${c.updated_at}`,
        title: `${c.id} ${c.user.login} ${c.path}:${c.line ?? c.original_line}${unanswered ? " · no reply" : ""}${thread ? ` · unresolved thread ${thread}` : ""}`,
        body: c.body,
      });
  }
  // Conversation comments have no threads: answered by your later comment quoting its permalink.
  const mine = conversation.filter((c) => c.user.login === viewer);
  for (const c of conversation) {
    if (c.user.login === viewer || isNoise(c)) continue;
    if (mine.some((m) => m.created_at > c.updated_at && links(m.body).includes(c.html_url))) continue;
    findings.push({ key: `${c.id}:${c.updated_at}`, title: `${c.id} ${c.user.login} conversation · no reply quoting ${c.html_url}`, body: c.body });
  }
  // A change request stands until that reviewer approves or it's dismissed.
  const latest = new Map();
  for (const r of reviews.filter((r) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)))
    latest.set(r.user.login, r);
  for (const r of latest.values())
    if (r.state === "CHANGES_REQUESTED") findings.push({ key: `review ${r.id}`, title: `review ${r.id} ${r.user.login} requested changes`, body: r.body });
  for (const f of findings) lines.push("", `[${f.title}]`, `  ${clean(f.body)}`);

  const verdict = sync.length ? "out-of-sync" : failed.length ? "failures" : !bot ? "no-bot" : findings.length ? "open-comments" : pending.length ? "pending" : "green";
  lines.push(`VERDICT ${verdict}`);
  return { lines, verdict, keys: [...failed.map((f) => `${head} ${f}`), ...findings.map((f) => f.key)], pending: pending.length };
}

/** --watch keeps waiting while something is pending and nothing new needs an answer. */
export function keepWaiting(result, seen) {
  return result.pending > 0 && result.verdict !== "out-of-sync" && result.keys.every((key) => seen.has(key));
}

const gh = (...args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 }));
const pages = (path) => gh("api", "--paginate", "--slurp", path);
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const checksOn = (repo, sha) => ({
  runs: pages(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).flatMap((p) => p.check_runs),
  statuses: pages(`repos/${repo}/commits/${sha}/status?per_page=100`).flatMap((p) => p.statuses),
});
const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor } nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } } }`;

function observe(repo, viewer, number) {
  const pr = gh("pr", "view", number, "--repo", repo, "--json", "number,state,headRefOid,headRefName,mergeable,labels");
  const head = pr.headRefOid;
  const { runs, statuses } = checksOn(repo, head);
  const [owner, name] = repo.split("/");
  const threads = gh("api", "graphql", "--paginate", "--slurp", "-f", `query=${THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`)
    .flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes);
  const inline = pages(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`).flat();
  const conversation = pages(`repos/${repo}/issues/${pr.number}/comments?per_page=100`).flat();
  const reviews = pages(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`).flat();

  let earlier;
  const bot = BOTS[pr.labels.map((l) => l.name).find((n) => n in BOTS)];
  if (bot && ["pending", "missing"].includes(botState(bot, runs, statuses))) {
    const shas = pages(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`).flat().map((c) => c.sha).reverse();
    const sha = shas.slice(1).find((s) => { const c = checksOn(repo, s); return botState(bot, c.runs, c.statuses) === "success"; });
    if (sha) earlier = { sha, files: gh("api", `repos/${repo}/compare/${sha}...${head}`).files.map((f) => f.filename) };
  }
  const local = git("branch", "--show-current") === pr.headRefName ? { sha: git("rev-parse", "HEAD"), upstream: git("rev-parse", "@{upstream}") } : undefined;
  // A verdict describes one commit: if the head moved while reading, it's stale.
  const headMoved = gh("pr", "view", number, "--repo", repo, "--json", "headRefOid").headRefOid !== head;
  return digest({ pr, viewer, local, headMoved, runs, statuses, threads, inline, conversation, reviews, earlier });
}

function main(args) {
  const watch = args.includes("--watch");
  const repo = gh("repo", "view", "--json", "nameWithOwner").nameWithOwner;
  const viewer = gh("api", "graphql", "-f", "query={ viewer { login } }").data.viewer.login;
  const number = String(args.find((a) => !a.startsWith("--")) ?? gh("pr", "view", "--json", "number").number);
  let result = observe(repo, viewer, number);
  const seen = new Set(result.keys);
  const deadline = Date.now() + Number(process.env.PR_DIGEST_DEADLINE ?? 7200) * 1000;
  while (watch && keepWaiting(result, seen) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PR_DIGEST_POLL ?? 30) * 1000);
    result = observe(repo, viewer, number);
  }
  console.log(result.lines.join("\n"));
  return EXIT[result.verdict] ?? 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // A failed read must never look like a clean PR.
    console.error(`pr-digest: ${error.message}`);
    process.exitCode = 1;
  }
}
