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
  },
});
