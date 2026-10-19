import { readdirSync } from "node:fs";

import { expect, test } from "vitest";

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
