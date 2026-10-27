import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = fileURLToPath(new URL("./apply-dependency-update.sh", import.meta.url));
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });

let directory: string;
afterEach(() => rmSync(directory, { recursive: true, force: true }));

// The agent's checkout, changed one way, and the patch it hands to the publishing job.
function patchFor(path: string, operation: "modify" | "add" | "delete" | "rename" | "symlink") {
  directory = mkdtempSync(join(tmpdir(), "dependency-update-"));
  const root = join(directory, "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "e2e-dependencies@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  for (const initial of ["package.json", "AGENTS.md", ".github/workflows/ci.yml"]) {
    mkdirSync(dirname(join(root, initial)), { recursive: true });
    writeFileSync(join(root, initial), "before\n");
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  if (operation === "delete") unlinkSync(file);
  else if (operation === "rename") renameSync(file, join(root, "renamed.yml"));
  else if (operation === "symlink") symlinkSync("package.json", file);
  else writeFileSync(file, "after\n");
  git(root, "add", "-N", ".");
  const patch = git(root, "diff", "--binary", "HEAD");
  git(root, "reset", "--hard", "-q", "HEAD");
  git(root, "clean", "-fdq");
  const temp = join(directory, "temp");
  mkdirSync(temp);
  writeFileSync(join(temp, "update.patch"), patch);
  const result = spawnSync("bash", [script, join(temp, "update.patch")], { cwd: root, env: { ...process.env, RUNNER_TEMP: temp } });
  return { root, file, patch, result };
}

test.each([
  ["package.json", "modify"],
  ["apps/web/src/new file.ts", "add"],
] as const)("applies a dependency change: %s (%s)", (path, operation) => {
  const { root, file, patch, result } = patchFor(path, operation);
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("after\n");
  expect(git(root, "diff", "--cached", "--binary")).toEqual(patch);
});

test.each([
  [".github/workflows/ci.yml", "modify"],
  [".github/workflows/ci.yml", "rename"],
  ["AGENTS.md", "delete"],
  ["apps/web/CLAUDE.md", "add"],
  [".claude/skills/pr-watch/SKILL.md", "add"],
  [".claude/settings.json", "add"],
  [".agents", "symlink"],
  [".coderabbit.yaml", "add"],
  ["greptile.json", "add"],
  [".greptile/rules.md", "add"],
  [".cursorrules", "add"],
  ["apps/web/.cursor/rules/deps.mdc", "add"],
  ["GEMINI.md", "add"],
  [".npmrc", "add"],
  [".env.production", "add"],
  ["apps/web/.env.example", "add"],
] as const)("refuses a patch that changes %s (%s), leaving the checkout as it was", (path, operation) => {
  const { root, result } = patchFor(path, operation);
  expect(result.status).not.toBe(0);
  expect(result.stdout.toString()).toContain("off limits");
  expect(git(root, "status", "--porcelain").toString()).toBe("");
});
