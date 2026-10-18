import { randomUUID } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

// Runs before each database test file: a fresh copy of the migrated template.
const url = new URL(inject("adminDatabaseUrl"));
const name = `test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
await admin.query(`CREATE DATABASE ${name} TEMPLATE tuti_template`);
await admin.end();
url.pathname = `/${name}`;

process.env.DATABASE_URL = url.href;
process.env.JOBS_DRIVER = "inline";
process.env.APP_URL = "http://tuti.localhost:3100";
process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
