import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Optional so `prisma generate` works without a database (fresh clones, CI).
    // Migrate/studio still fail clearly when it's missing.
    url: process.env.DATABASE_URL,
    // Only needed by `prisma migrate dev` when the DB user can't create databases.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
