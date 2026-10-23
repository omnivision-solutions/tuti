import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { installationApi } from "./github-api";
import { DIFF_CAP, leftOut, maskSecrets, readPullRequest } from "./pull-request";

let github: GithubFake;
beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(() => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
});

test("lockfiles, generated files, binaries and files that hold secrets are left out", () => {
  expect(
    Object.fromEntries(
      [
        "src/app.ts",
        "pnpm-lock.yaml",
        "apps/web/package-lock.json",
        "go.sum",
        "dist/index.js",
        "public/app.min.js",
        "src/__snapshots__/a.test.ts.snap",
        "api/types.generated.ts",
        "logo.png",
        "fonts/Inter.woff2",
        ".env",
        "apps/web/.env.production",
        "certs/server.pem",
        "deploy/id_ed25519",
        ".npmrc",
        "config/credentials.json",
        "docs/environment.md",
        "src/key-value.ts",
      ].map((path) => [path, leftOut(path) ?? "read"]),
    ),
  ).toEqual({
    "src/app.ts": "read",
    "pnpm-lock.yaml": "lockfile",
    "apps/web/package-lock.json": "lockfile",
    "go.sum": "lockfile",
    "dist/index.js": "generated",
    "public/app.min.js": "generated",
    "src/__snapshots__/a.test.ts.snap": "generated",
    "api/types.generated.ts": "generated",
    "logo.png": "binary",
    "fonts/Inter.woff2": "binary",
    ".env": "secrets",
    "apps/web/.env.production": "secrets",
    "certs/server.pem": "secrets",
    "deploy/id_ed25519": "secrets",
    ".npmrc": "secrets",
    "config/credentials.json": "secrets",
    "docs/environment.md": "read",
    "src/key-value.ts": "read",
  });
});

test("secret-looking strings are masked; ordinary code stays as it was", () => {
  const masked = maskSecrets(
    [
      '+const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
      "+OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef",
      "+  url: postgres://tuti:hunter2hunter2@db.internal:5432/tuti",
      "+aws = AKIAABCDEFGHIJKLMNOP",
      '+  password: "correct-horse-battery"',
      "+STRIPE_SECRET=rk_live_abcdefghijklmnop",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+MIIEowIBAAKCAQEA",
      "+-----END RSA PRIVATE KEY-----",
      "+const tokens = await getTokens(user);",
      '+const label = "Password";',
    ].join("\n"),
  );
  expect(masked.split("\n")).toEqual([
    '+const token = "[secret]";',
    "+OPENROUTER_API_KEY=[secret]",
    "+  url: postgres://tuti:[secret]@db.internal:5432/tuti",
    "+aws = [secret]",
    '+  password: "[secret]"',
    "+STRIPE_SECRET=[secret]",
    "+[secret]",
    "+const tokens = await getTokens(user);",
    '+const label = "Password";',
  ]);
});

test("reads the pull request, its commits and its files; the diff without what's left out, masked and capped", async () => {
  github.pullRequest("acme/app", {
    number: 7,
    title: "Dark mode",
    body: "Adds a theme switch. Uses sk-abcdefghijklmnopqrstuvwxyz012345 locally.",
    labels: ["feature"],
    author: "octo",
    mergedAt: "2026-10-20T10:00:00Z",
    commits: ["Add theme switch\n\nLong description", "Fix contrast"],
    files: [
      { filename: "src/theme.ts", additions: 2, patch: "@@ -1 +1,2 @@\n+export const dark = true;\n+const key = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\";" },
      { filename: "pnpm-lock.yaml", additions: 900, patch: "+lots: of lines" },
      { filename: ".env.local", additions: 1, patch: "+SECRET=abc" },
      // GitHub sent no patch (too big): its start at the merge commit says what it is.
      { filename: "src/big.ts", additions: 5000, content: "export const big = 1;\n" },
      { filename: "src/huge.bin.ts", additions: 9000 },
      { filename: "src/old.ts", status: "removed", additions: 0, deletions: 3, patch: "-gone" },
    ],
  });
  const read = await readPullRequest(await installationApi(42), "acme/app", 7);
  expect(read).toEqual({
    title: "Dark mode",
    body: "Adds a theme switch. Uses [secret] locally.",
    labels: ["feature"],
    author: "octo",
    mergedAt: "2026-10-20T10:00:00Z",
    commits: ["Add theme switch", "Fix contrast"],
    files: [
      { path: "src/theme.ts", status: "modified", additions: 2, deletions: 0 },
      { path: "pnpm-lock.yaml", status: "modified", additions: 900, deletions: 0, left: "lockfile" },
      { path: ".env.local", status: "modified", additions: 1, deletions: 0, left: "secrets" },
      { path: "src/big.ts", status: "modified", additions: 5000, deletions: 0 },
      { path: "src/huge.bin.ts", status: "modified", additions: 9000, deletions: 0, left: "size" },
      { path: "src/old.ts", status: "removed", additions: 0, deletions: 3 },
    ],
    diff: [
      "--- src/theme.ts (modified, +2 -0)",
      "@@ -1 +1,2 @@",
      "+export const dark = true;",
      '+const key = "[secret]";',
      "--- src/big.ts (modified, +5000 -0), whole file",
      "export const big = 1;",
      "",
      "--- src/old.ts (removed, +0 -3)",
      "-gone",
    ].join("\n"),
  });
  expect(read.diff).not.toContain("lots: of lines");
});

test("a big pull request: the diff stops at the cap, and the files after it are listed as left out", async () => {
  const patch = `+${"x".repeat(5_000)}`;
  github.pullRequest("acme/app", {
    number: 8,
    title: "Big",
    files: Array.from({ length: 150 }, (_, i) => ({ filename: `src/file-${i}.ts`, patch })),
  });
  const read = await readPullRequest(await installationApi(42), "acme/app", 8);
  expect(read.files).toHaveLength(150);
  expect(read.diff.length).toBeLessThanOrEqual(DIFF_CAP + 100);
  expect(read.files.filter((file) => file.left === "size").length).toBeGreaterThan(140);
});

test("a secret cut by the cap is still masked", async () => {
  github.pullRequest("acme/app", {
    number: 9,
    title: "Cut",
    // The token starts just before the file's share ends.
    files: [{ filename: "src/a.ts", patch: `+${"x".repeat(5_990)} ghp_abcdefghijklmnopqrstuvwxyz0123456789` }],
  });
  const read = await readPullRequest(await installationApi(42), "acme/app", 9);
  expect(read.diff).not.toContain("ghp_");
  expect(read.diff).toContain("[secr");
});
