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
// commits: who wrote each of its commits (null or a name: an email on no account); its author by default.
type Pull = { number: number; user: User; head: { sha: string }; state: string; commits?: (User | null | string)[]; count?: number };
type Comment = { user: { login: string }; body: string };
const user = (login: string, type = "User"): User => ({ login, type });
const pull = (number: number, author: User, sha = `sha${number}`): Pull => ({ number, user: author, head: { sha }, state: "open" });
const comment = (login: string, body: string): Comment => ({ user: { login }, body });

// GitHub's API as `gh api` answers it, from these pull requests, permissions and comments; the
// list holds every pull request, and each is open unless it says otherwise.
const fakeGh = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.LOG, args.join(" ") + "\\n");
const { pulls, permissions, comments, down } = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const path = args.find((arg) => /^(repos|search)\\//.test(arg));
if (down && args.some((arg) => arg.includes(down))) { console.error("HTTP 502"); process.exit(1); }
let match, answer;
if ((match = path.match(/^repos\\/o\\/r\\/pulls\\/(\\d+)$/))) {
  const p = pulls.find((p) => p.number === +match[1]);
  answer = { ...p, commits: p.count ?? (p.commits ?? [p.user]).length };
}
else if ((match = path.match(/^repos\\/o\\/r\\/pulls\\/(\\d+)\\/commits\\?/))) {
  const p = pulls.find((p) => p.number === +match[1]);
  answer = (p.commits ?? [p.user]).map((author) => ({ author: typeof author === "string" ? null : author, commit: { author: { name: typeof author === "string" ? author : "Some One" } } }));
}
else if ((match = path.match(/collaborators\\/(.+)\\/permission$/))) {
  if (!permissions[match[1]]) { console.error("HTTP 404"); process.exit(1); }
  answer = { permission: permissions[match[1]] };
} else if ((match = path.match(/issues\\/(\\d+)\\/comments\\?/))) answer = [comments[match[1]] ?? []];
else if ((match = path.match(/^repos\\/o\\/r\\/pulls\\?state=(\\w+)&/))) answer = pulls.filter((p) => match[1] === "all" || p.state === match[1]);
else process.exit(0);
const json = JSON.stringify(answer);
process.stdout.write(args.includes("--jq") ? execFileSync("jq", ["-r", flag("--jq")], { input: json }) : json);
`;

function run({
  pulls = [pull(7, user("someone"))],
  permissions = {} as Record<string, string>,
  comments = {} as Record<number, Comment[]>,
  down = "",
  fails = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cla-"));
  directories.push(directory);
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ pulls, permissions, comments, down }));
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
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(fails ? 1 : 0);
  if (!fails) expect(result.stderr).toBe("");
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return {
    status: (sha = "sha7") => calls.find((call) => call.startsWith(`api repos/o/r/statuses/${sha} `)),
    calls,
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
  const closed = { ...pull(3, user("someone")), state: "closed" };
  const earlier = run({ pulls: [pull(7, user("someone")), closed], comments: { 3: [comment("someone", SIGN)] } }).status();
  expect(earlier).toContain("state=success");
  expect(earlier).toContain("#3");
  // Only the author's own comment counts.
  expect(run({ pulls: [pull(7, user("someone")), closed], comments: { 3: [comment("other", SIGN)] } }).status()).toContain("state=failure");
});

test("signing passes the author's other open pull requests too", () => {
  const signing = run({ pulls: [pull(7, user("someone")), pull(8, user("someone"))], comments: { 7: [comment("someone", SIGN)] } });
  expect(signing.status("sha7")).toContain("state=success");
  expect(signing.status("sha8")).toContain("state=success");
  // The author's verdict is read once, not once per pull request.
  expect(signing.calls.filter((call) => call.includes("collaborators/someone/permission"))).toHaveLength(1);
});

test("a commit shared with a team member's pull request still needs the outside author's signature", () => {
  const shared = run({ pulls: [pull(7, user("member"), "same"), pull(9, user("someone"), "same")], permissions: { member: "write" } });
  expect(shared.status("same")).toContain("state=failure");
  expect(shared.status("same")).toContain("someone");
  // Asked on their own pull request, where their comment reruns the check, not on the member's.
  expect(shared.asked(7)).toBe(false);
  // Whichever comes first.
  const reversed = run({ pulls: [pull(9, user("someone"), "same"), pull(7, user("member"), "same")], permissions: { member: "write" } });
  expect(reversed.status("same")).toContain("state=failure");
});

test("only the sentence itself signs, not a quote reply that adds to it", () => {
  expect(run({ comments: { 7: [comment("someone", `> ${SIGN}\n\nDoes this cover my employer's code?`)] } }).status()).toContain("state=failure");
  expect(run({ comments: { 7: [comment("someone", `  ${SIGN.toUpperCase()}!\n`)] } }).status()).toContain("state=success");
});

test("when GitHub doesn't answer, the job fails without calling anyone unsigned", () => {
  for (const down of ["/permission", "state=open", "state=all", "/comments?"]) {
    const failed = run({ down, fails: true });
    expect(failed.status()).toBeUndefined();
    expect(failed.asked()).toBe(false);
  }
});

test("a team member's pull request with an outsider's commits needs the outsider's signature", () => {
  const takenOver = { ...pull(7, user("member")), commits: [user("member"), user("someone")] };
  const result = run({ pulls: [takenOver], permissions: { member: "write" } });
  expect(result.status()).toContain("state=failure");
  expect(result.status()).toContain("someone");
  // The member isn't asked to sign: the status names who must.
  expect(result.asked()).toBe(false);
  expect(run({ pulls: [{ ...takenOver, commits: [user("member"), null] }], permissions: { member: "write" } }).status()).toContain("Some One");
});

test("a commit author who signed on their own pull request, even a closed one, passes a team member's", () => {
  const theirs = { ...pull(3, user("someone")), state: "closed" };
  const takenOver = { ...pull(7, user("member")), commits: [user("someone")] };
  const result = run({ pulls: [takenOver, theirs], permissions: { member: "write" }, comments: { 3: [comment("someone", SIGN)] } });
  expect(result.status()).toContain("state=success");
});

test("over 250 commits fails: GitHub doesn't list the rest", () => {
  const result = run({ pulls: [{ ...pull(7, user("member")), count: 251 }], permissions: { member: "write" } });
  expect(result.status()).toContain("state=failure");
  expect(result.status()).toContain("250");
});

test("each commit with no account is named in its own pull request's status", () => {
  const result = run({
    pulls: [{ ...pull(7, user("member")), commits: ["Alice"] }, { ...pull(8, user("member")), commits: ["Bob"] }],
    permissions: { member: "write" },
  });
  expect(result.status("sha7")).toContain("Alice");
  expect(result.status("sha8")).toContain("Bob");
});

test("a pull request GitHub doesn't answer for leaves its commit alone, not everyone's", () => {
  const result = run({ pulls: [pull(7, user("member")), pull(8, user("member"))], permissions: { member: "write" }, down: "pulls/8/commits", fails: true });
  expect(result.status("sha7")).toContain("state=success");
  expect(result.status("sha8")).toBeUndefined();
});

test("no open pull requests: nothing to post", () => {
  expect(run({ pulls: [{ ...pull(7, user("someone")), state: "closed" }] }).status()).toBeUndefined();
});
