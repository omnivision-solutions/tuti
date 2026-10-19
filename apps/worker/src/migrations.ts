import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";

/**
 * Waits until the database has `migration`, the newest one this build knows
 * (the web app applies migrations when it starts). After a deploy that changes
 * the schema, the worker can otherwise start first and run jobs against the old one.
 */
export async function waitForMigration(migration: string, { every = 5_000, max = 15 * 60_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const applied = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = ${migration} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
      // A new database has no migrations table until the first migration.
      .catch(() => [{ n: 0 }]);
    if (applied[0]!.n > 0) {
      return;
    }
    if (Date.now() - started >= max) {
      throw new Error(`The database still doesn't have migration ${migration}; is the web app running?`);
    }
    log.info("Waiting for the web app to apply the database migrations", { migration });
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}
