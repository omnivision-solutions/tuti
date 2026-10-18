import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

const dbPackage = fileURLToPath(new URL("../../db", import.meta.url));

/**
 * A throwaway Postgres (with pgvector) in Docker, with Tuti's migrations applied
 * to `database`. Returns its superuser URL for that database, and `stop`.
 */
export async function startMigratedPostgres(database: string) {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withDatabase(database).start();
  const url = container.getConnectionUri();
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: dbPackage,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return { url, stop: () => container.stop() };
}
