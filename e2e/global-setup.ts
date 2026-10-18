import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

import { startMigratedPostgres } from "@tuti/testkit/postgres";

import { SCREENSHOTS_DIR } from "./checkpoint";
import { APP_URL, serverEnv } from "./env";

/**
 * A throwaway Postgres and the production build of the web app (`pnpm build`
 * first; `pnpm test:e2e` does), with background jobs running inline.
 */
export default async function globalSetup() {
  rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
  const postgres = await startMigratedPostgres("tuti_e2e");
  const server = spawn("node_modules/.bin/next", ["start"], {
    cwd: "apps/web",
    env: { ...process.env, ...serverEnv, DATABASE_URL: postgres.url, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });

  const deadline = Date.now() + 30_000;
  while (!(await fetch(APP_URL).then((r) => r.ok, () => false))) {
    if (server.exitCode !== null || Date.now() > deadline) {
      throw new Error(`The web app didn't start on ${APP_URL} (did you run pnpm build?)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return async () => {
    server.kill();
    await postgres.stop();
  };
}
