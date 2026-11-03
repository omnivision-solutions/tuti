import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./cla.sh", import.meta.url));
const SIGN = "I have read the CLA and agree to it";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

type User = { login: string; type: string };
type Pull = { number: number; user: User; head: { sha: string }; state: string };
type Comment = { user: { login: string }; body: string };
const user = (login: string, type = "User"): User => ({ login, type });
const pull = (number: number, author: User, sha = `sha${number}`): Pull => ({ number, user: author, head: { sha }, state: "open" });
const comment = (login: string, body: string): Comment => ({ user: { login }, body });

// GitHub's API as `gh api` answers it, from these pull requests, permissions and comments; the
// search finds every pull request a login commented on or opened.
const fakeGh = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, args.join(" ") + "\\n");
const { pulls, permissions, comments } = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const path = args.find((arg) => /^(repos|search)\\//.test(arg));
let match, answer;
if ((match = path.match(/^repos\\/o\\/r\\/pulls\\/(\\d+)$/))) answer = pulls.find((p) => p.number === +match[1]);
else if ((match = path.match(/collaborators\\/(.+)\\/permission$/))) {
  if (!permissions[match[1]]) { console.error("HTTP 404"); process.exit(1); }
  answer = { permission: permissions[match[1]] };
} else if ((match = path.match(/commits\\/(.+)\\/pulls$/))) answer = pulls.filter((p) => p.head.sha === match[1]);
else if ((match = path.match(/issues\\/(\\d+)\\/comments\\?/))) answer = [comments[match[1]] ?? []];
else if (path === "search/issues") {
  const q = args.find((arg) => arg.startsWith("q="));
  const who = q.match(/(?:commenter|author):(\\S+)/)[1];
  const numbers = q.includes("commenter:")
    ? Object.keys(comments).filter((n) => comments[n].some((c) => c.user.login === who)).map(Number)
    : pulls.filter((p) => p.user.login === who).map((p) => p.number);
  answer = { items: numbers.map((number) => ({ number })) };
} else process.exit(0);
const json = JSON.stringify(answer);
process.stdout.write(args.includes("--jq") ? execFileSync("jq", ["-r", flag("--jq")], { input: json }) : json);
`;

function run({
  pulls = [pull(7, user("someone"))],
  permissions = {} as Record<string, string>,
  comments = {} as Record<number, Comment[]>,
  event = "pull_request_target",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cla-"));
  directories.push(directory);
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ pulls, permissions, comments }));
  writeFileSync(join(directory, "gh"), fakeGh);
  chmodSync(join(directory, "gh"), 0o755);
  const log = join(directory, "log");
  writeFileSync(log, "");
  const result = spawnSync("bash", [script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      FIXTURE: join(directory, "fixture.json"),
      LOG: log,
      REPO: "o/r",
      PR: "7",
      AUTHOR: pulls[0].user.login,
      EVENT: event,
    },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return {
    status: (sha = "sha7") => calls.find((call) => call.startsWith(`api repos/o/r/statuses/${sha} `)),
    asked: (number = 7) => calls.some((call) => call.startsWith(`api repos/o/r/issues/${number}/comments --silent`)),
  };
}

test("the team and bots don't sign", () => {
  expect(run({ permissions: { someone: "write" } }).status()).toContain("state=success");
  expect(run({ permissions: { someone: "admin" } }).status()).toContain("state=success");
  expect(run({ pulls: [pull(7, user("dependabot[bot]", "Bot"))] }).status()).toContain("state=success");
});

test("an outside author who hasn't signed fails, and is asked once", () => {
  const first = run({ permissions: { someone: "read" }, comments: { 7: [comment("someone", "Here's a fix"), comment("other", SIGN)] } });
  expect(first.status()).toContain("state=failure");
  expect(first.asked()).toBe(true);
  const again = run({ comments: { 7: [comment("github-actions[bot]", `<!-- tuti-cla -->\n> ${SIGN}`)] } });
  expect(again.status()).toContain("state=failure");
  expect(again.asked()).toBe(false);
});

test("a signature on this pull request or an earlier one passes", () => {
  expect(run({ comments: { 7: [comment("someone", "i have read the CLA and agree to it.")] } }).status()).toContain("state=success");
  const earlier = run({ comments: { 3: [comment("someone", SIGN)] } }).status();
  expect(earlier).toContain("state=success");
  expect(earlier).toContain("#3");
  // The search matches loosely: only the author's own comment counts.
  expect(run({ comments: { 3: [comment("other", SIGN)] } }).status()).toContain("state=failure");
});

test("signing passes the author's other open pull requests too", () => {
  const signing = run({ event: "issue_comment", pulls: [pull(7, user("someone")), pull(8, user("someone"))], comments: { 7: [comment("someone", SIGN)] } });
  expect(signing.status("sha7")).toContain("state=success");
  expect(signing.status("sha8")).toContain("state=success");
});

test("a commit shared with a team member's pull request still needs the outside author's signature", () => {
  const shared = run({ pulls: [pull(7, user("member"), "same"), pull(9, user("someone"), "same")], permissions: { member: "write" } });
  expect(shared.status("same")).toContain("state=failure");
  expect(shared.status("same")).toContain("someone");
});
