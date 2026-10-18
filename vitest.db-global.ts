import { execFileSync } from "node:child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Superuser URL of the test Postgres, connected to its "postgres" database. */
    adminDatabaseUrl: string;
  }
}

/**
 * Starts a throwaway Postgres (with pgvector) for the database tests and
 * migrates a template database once. Each test file then gets its own copy
 * (see vitest.db-setup.ts), so files run in parallel without sharing data.
 */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withDatabase("tuti_template").start();
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: "packages/db",
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: "pipe",
  });
  const admin = new URL(container.getConnectionUri());
  admin.pathname = "/postgres";
  project.provide("adminDatabaseUrl", admin.href);
  return () => container.stop();
}
