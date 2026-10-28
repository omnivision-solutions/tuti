import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * The built worker starts: its bundle (tsup.config.ts) loads in Node and gets as far as checking its
 * settings. tsup bundles the workspace packages and keeps npm packages external only when they're the
 * worker's own dependencies; a CommonJS one that isn't (as `pg` was) gets bundled, and the worker then
 * fails before it starts ("Dynamic require of "events" is not supported").
 */
test("the built worker loads, and stops only for its missing settings", () => {
  const app = fileURLToPath(new URL("..", import.meta.url));
  // Inside the app, so the bundle finds its external packages in the app's node_modules.
  const out = mkdtempSync(join(app, ".bundle-test-"));
  try {
    // tsup's own CLI script run by Node, not a shell shim (pnpm and npx are .cmd files on Windows).
    const tsup = createRequire(join(app, "package.json")).resolve("tsup/package.json");
    execFileSync(process.execPath, [join(dirname(tsup), "dist/cli-default.js"), "--out-dir", out, "--silent"], { cwd: app, stdio: "pipe" });
    const run = spawnSync(process.execPath, [join(out, "index.js")], { cwd: app, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000 });
    expect(run.stderr).not.toContain("Dynamic require");
    expect(run.stderr).toContain("Missing required environment variables: DATABASE_URL");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
