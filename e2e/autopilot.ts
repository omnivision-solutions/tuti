import { createHmac } from "node:crypto";

import { expect } from "@playwright/test";
import pg from "pg";

import { APP_URL, serverEnv } from "./env";

/**
 * Autopilot's minute, run by hand (the server's timer is off in journeys): with `dueNow`, the project's
 * scheduled updates are due first (as if their hold passed); with `emailNow`, its email goes now. How many went out, and how many wait, in
 * every project (other journeys' too).
 */
export async function runAutopilot(slug: string, { dueNow = false, emailNow = false } = {}): Promise<{ applied: number; waiting: number; emailed: number }> {
  if (dueNow || emailNow) {
    const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await client.connect();
    try {
      if (dueNow) {
        await client.query(
          `UPDATE code_change_action a SET "dueAt" = now() - interval '1 second'
           FROM code_change c JOIN project p ON p.id = c."projectId"
           WHERE a."codeChangeId" = c.id AND p.slug = $1 AND a.status = 'SCHEDULED'`,
          [slug],
        );
      }
      // Its notices as if ten minutes passed (nothing else merged meanwhile): its email goes in this minute.
      if (emailNow) {
        await client.query(
          `UPDATE autopilot_notice n SET "createdAt" = now() - interval '11 minutes'
           FROM code_change c JOIN project p ON p.id = c."projectId"
           WHERE n."codeChangeId" = c.id AND p.slug = $1 AND n."sentAt" IS NULL`,
          [slug],
        );
      }
    } finally {
      await client.end();
    }
  }
  const token = createHmac("sha256", serverEnv.BETTER_AUTH_SECRET).update("autopilot-due").digest("hex");
  const response = await fetch(`${APP_URL}/api/autopilot/due`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as { applied: number; waiting: number; emailed: number };
}
