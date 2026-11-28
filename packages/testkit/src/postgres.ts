import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

const dbPackage = fileURLToPath(new URL("../../db", import.meta.url));

/**
 * A throwaway Postgres (with pgvector) in Docker, with Tuti's migrations applied
 * to `database`. Returns its superuser URL for that database, and `stop`.
 */
export async function startMigratedPostgres(database: string) {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase(database)
    // Thrown away after the run, so nothing waits on the disk: every commit and every test file's database copy
    // otherwise does, and on CI's runners that wait is what pushes a test past its 5 s. Connections for a test worker per
    // CPU, each with its pool of 10: the default 100 runs out on a machine with more than about 9.
    .withCommand(["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=500"])
    .start();
  const url = container.getConnectionUri();
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: dbPackage,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return { url, stop: () => container.stop() };
}
