import { readdirSync } from "node:fs";

import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import { waitForMigration } from "./migrations";

const latest = readdirSync(new URL("../../../packages/db/prisma/migrations", import.meta.url))
  .filter((name) => /^\d/.test(name))
  .sort()
  .at(-1)!;

test("the worker starts once the database has its newest migration, and gives up on one that never comes", async () => {
  await expect(waitForMigration(latest)).resolves.toBeUndefined();
  await expect(waitForMigration("29991231000000_from_the_future", { every: 10, max: 50 })).rejects.toThrow(
    "doesn't have migration 29991231000000_from_the_future",
  );
});

test("a database it can't query stops the worker at once instead of looking like a missing migration", async () => {
  vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("password authentication failed"));
  await expect(waitForMigration(latest, { every: 10, max: 60_000 })).rejects.toThrow("password authentication failed");
});

test("a new database without a migrations table yet means waiting, not an error", async () => {
  const query = vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ exists: false }]);
  await expect(waitForMigration(latest, { every: 10, max: 50 })).rejects.toThrow(`doesn't have migration ${latest}`);
  expect(query.mock.calls.length).toBeGreaterThan(1); // it kept checking
  query.mockRestore();
});
