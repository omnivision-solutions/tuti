import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FAKE_OPENAI_KEY, startGithubFake, startOpenAIFake, startS3Fake } from "@tuti/testkit";
import { startMigratedPostgres } from "@tuti/testkit/postgres";
import { startSmtpFake } from "@tuti/testkit/smtp";

import { SCREENSHOTS_DIR } from "./checkpoint";
import { APP_URL, serverEnv } from "./env";
import { MAIL_DIR } from "./mail";

/**
 * A throwaway Postgres, a local SMTP server (emails land in e2e-mail/), the
 * OpenAI fake (embeddings for duplicate detection), the S3 fake (image uploads) and the
 * production build of the web app (`pnpm build` first; `pnpm test:e2e` does),
 * with background jobs running inline.
 */
export default async function globalSetup() {
  rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
  rmSync(MAIL_DIR, { recursive: true, force: true });
  mkdirSync(MAIL_DIR);
  let sent = 0;
  const smtp = await startSmtpFake({
    // Written under a temporary name, then renamed: readers only ever see whole files.
    onEmail: (email) => {
      const name = join(MAIL_DIR, `${String(++sent).padStart(5, "0")}.json`);
      writeFileSync(`${name}.tmp`, JSON.stringify(email));
      renameSync(`${name}.tmp`, name);
    },
  });
  const openai = await startOpenAIFake();
  // Journeys run in other processes; they set vectors through the fake's /fixtures (e2e/openai.ts).
  process.env.E2E_OPENAI_URL = openai.url;
  const s3 = await startS3Fake();
  const github = await startGithubFake();
  // The GitHub journey tells the fake what its install page should do (e2e/github.spec.ts).
  github.nextInstall(`${APP_URL}/api/github/setup`, { id: 424242, account: "acme-e2e", code: "e2e-install-code" });
  const postgres = await startMigratedPostgres("tuti_e2e");
  const server = spawn("node_modules/.bin/next", ["start"], {
    cwd: "apps/web",
    env: {
      ...process.env,
      ...serverEnv,
      DATABASE_URL: postgres.url,
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
      OPENAI_BASE_URL: openai.url,
      SMTP_HOST: smtp.host,
      SMTP_PORT: String(smtp.port),
      ...s3.env,
      ...github.env,
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
    await Promise.all([postgres.stop(), smtp.close(), openai.close(), s3.close(), github.close()]);
  };
}
