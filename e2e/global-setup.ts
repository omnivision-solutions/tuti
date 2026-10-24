import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { FAKE_OPENAI_KEY, startCloudflareFake, startDnsFake, startGithubFake, startModelFake, startOpenAIFake, startS3Fake, startSiteFake } from "@tuti/testkit";
import { startMigratedPostgres } from "@tuti/testkit/postgres";
import { startSmtpFake } from "@tuti/testkit/smtp";

import { SCREENSHOTS_DIR } from "./checkpoint";
import { APP_URL, serverEnv } from "./env";
import { MAIL_DIR } from "./mail";

/**
 * A throwaway Postgres, a local SMTP server (emails land in e2e-mail/), the
 * OpenAI fake (embeddings for duplicate detection), the model fake (AI drafting), the S3 fake (image uploads), the
 * DNS fake (custom domains' TXT records), the Cloudflare fake (their certificates) and the
 * production build of the web app (`pnpm build` first; `pnpm test:e2e` does),
 * with background jobs running inline.
 */
export default async function globalSetup() {
  // A server already on the port (another checkout's run) would answer for ours, which then
  // fails to start: the journeys would quietly test that other code. (Checked again below: the
  // run waits for its own server to say it's listening.)
  if (await portTaken(new URL(APP_URL))) {
    throw new Error(`Something is already serving ${APP_URL} (another test run?). Stop it, or set E2E_PORT to a free port.`);
  }
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
  const model = await startModelFake();
  // Journeys script its replies through /_fake/replies (e2e/model.ts).
  process.env.E2E_MODEL_URL = model.url;
  const s3 = await startS3Fake();
  const github = await startGithubFake();
  // Journeys set up their own installs through the fake's /_fake/next-install (e2e/github.ts).
  process.env.E2E_GITHUB_URL = github.url;
  const dns = await startDnsFake();
  // Journeys publish TXT records through the fake's /_fake/txt (e2e/dns.ts).
  process.env.E2E_DNS_URL = new URL(dns.url).origin;
  const cloudflare = await startCloudflareFake();
  // Journeys say when Cloudflare has a domain's certificate through /_fake/certificate (e2e/dns.ts).
  process.env.E2E_CLOUDFLARE_URL = cloudflare.env.CLOUDFLARE_API_URL;
  const site = await startSiteFake();
  // A team's own website; journeys make it forward a path to their portal through /_fake/forward (e2e/site.ts).
  process.env.E2E_SITE_URL = site.origin;
  const postgres = await startMigratedPostgres("tuti_e2e");
  // Journeys spend a project's AI credits, and grant them with the operator's script (e2e/credits.ts).
  process.env.E2E_DATABASE_URL = postgres.url;
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
      ...model.env,
      ...s3.env,
      ...github.env,
      DNS_LOOKUP_URL: dns.url,
      ...cloudflare.env,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  // Next.js logs "Ready in" once *this* server listens; a server that couldn't take the port exits
  // instead, so another run's server answering on it can't pass for ours.
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096);
  });

  const deadline = Date.now() + 30_000;
  while (!output.includes("Ready in") || !(await fetch(APP_URL).then((r) => r.ok, () => false))) {
    if (server.exitCode !== null || Date.now() > deadline) {
      throw new Error(`The web app didn't start on ${APP_URL} (did you run pnpm build? is the port free?)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return async () => {
    server.kill();
    await Promise.all([postgres.stop(), smtp.close(), openai.close(), model.close(), s3.close(), github.close(), dns.close(), cloudflare.close(), site.close()]);
    // Every scripted reply was used, and nothing asked the model unscripted.
    model.done();
  };
}

/** Whether something accepts connections on the URL's port (a timeout counts as taken). */
function portTaken({ hostname, port }: URL) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    const done = (taken: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(taken);
    };
    const timer = setTimeout(() => done(true), 1_000);
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED"));
  });
}
