import { readdirSync } from "node:fs";

import { defineConfig } from "tsup";

/** The newest database migration, which the built worker waits for (see src/migrations.ts). */
const latestMigration = readdirSync(new URL("../../packages/db/prisma/migrations", import.meta.url))
  .filter((name) => /^\d/.test(name))
  .sort()
  .at(-1)!;

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Bundle workspace packages (they ship TypeScript source); keep npm deps external.
  noExternal: [/^@tuti\//],
  env: { TUTI_SCHEMA_MIGRATION: latestMigration },
});
