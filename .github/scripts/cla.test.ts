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

type Comment = { user: { login: string }; body: string };
const comment = (login: string, body: string): Comment => ({ user: { login }, body });

// GitHub's API as `gh api` answers it: comments per pull request, the author's permission, what the search finds.
function run({ permission = "read", type = "User", comments = {} as Record<number, Comment[]>, found = [] as number[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cla-"));
  directories.push(directory);
  writeFileSync(join(directory, "comments.json"), JSON.stringify(comments));
  const gh = join(directory, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
echo "$*" >> "$LOG"
case "$*" in
  "api repos/o/r/pulls/7 --jq .head.sha") echo abc ;;
  *collaborators/*) [[ "$PERMISSION" == none ]] && { echo "HTTP 404" >&2; exit 1; }; echo "$PERMISSION" ;;
  *search/issues*) echo "$FOUND" | tr ' ' '\\n' ;;
  "api --paginate --slurp repos/o/r/issues/"*) n=\${4#repos/o/r/issues/}; jq --arg n "\${n%%/*}" '[.[$n] // []]' "$DIR/comments.json" ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const log = join(directory, "log");
  writeFileSync(log, "");
  const result = spawnSync("bash", [script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      DIR: directory,
      LOG: log,
      REPO: "o/r",
      PR: "7",
      AUTHOR: "someone",
      AUTHOR_TYPE: type,
      PERMISSION: permission,
      FOUND: found.join(" "),
    },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  const status = calls.find((call) => call.includes("statuses/abc"));
  return { status, asked: calls.some((call) => call.startsWith("api repos/o/r/issues/7/comments")) };
}

test("the team and bots don't sign", () => {
  expect(run({ permission: "write" }).status).toContain("state=success");
  expect(run({ permission: "admin" }).status).toContain("state=success");
  expect(run({ type: "Bot", permission: "none" }).status).toContain("state=success");
});

test("an outside author who hasn't signed fails, and is asked once", () => {
  const first = run({ permission: "none", comments: { 7: [comment("someone", "Here's a fix"), comment("other", SIGN)] } });
  expect(first.status).toContain("state=failure");
  expect(first.asked).toBe(true);
  const again = run({ comments: { 7: [comment("github-actions[bot]", `<!-- tuti-cla -->\n> ${SIGN}`)] } });
  expect(again.status).toContain("state=failure");
  expect(again.asked).toBe(false);
});

test("a signature on this pull request or an earlier one passes", () => {
  expect(run({ comments: { 7: [comment("someone", `i have read the CLA and agree to it.`)] } }).status).toContain("state=success");
  const earlier = run({ comments: { 3: [comment("someone", SIGN)] }, found: [3, 7] });
  expect(earlier.status).toContain("state=success");
  expect(earlier.status).toContain("#3");
  // The search matches loosely: only the author's own comment counts.
  expect(run({ comments: { 3: [comment("other", SIGN)] }, found: [3] }).status).toContain("state=failure");
});
