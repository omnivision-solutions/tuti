import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startMigratedPostgres } from "@tuti/testkit/postgres";
import { startSmtpFake } from "@tuti/testkit/smtp";

import { SCREENSHOTS_DIR } from "./checkpoint";
import { APP_URL, serverEnv } from "./env";
import { MAIL_DIR } from "./mail";

/**
 * A throwaway Postgres, a local SMTP server (emails land in e2e-mail/) and the
 * production build of the web app (`pnpm build` first; `pnpm test:e2e` does),
 * with background jobs running inline.
 */
export default async function globalSetup() {
  rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
  rmSync(MAIL_DIR, { recursive: true, force: true });
  mkdirSync(MAIL_DIR);
  let sent = 0;
  const smtp = await startSmtpFake({
    onEmail: (email) => writeFileSync(join(MAIL_DIR, `${String(++sent).padStart(5, "0")}.json`), JSON.stringify(email)),
  });
  const postgres = await startMigratedPostgres("tuti_e2e");
  const server = spawn("node_modules/.bin/next", ["start"], {
    cwd: "apps/web",
    env: {
      ...process.env,
      ...serverEnv,
      DATABASE_URL: postgres.url,
      SMTP_HOST: smtp.host,
      SMTP_PORT: String(smtp.port),
      NODE_ENV: "production",
    },
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
    await Promise.all([postgres.stop(), smtp.close()]);
  };
}
