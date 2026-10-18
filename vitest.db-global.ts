import { startMigratedPostgres } from "@tuti/testkit/postgres";
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
  const postgres = await startMigratedPostgres("tuti_template");
  const admin = new URL(postgres.url);
  admin.pathname = "/postgres";
  project.provide("adminDatabaseUrl", admin.href);
  return postgres.stop;
}
