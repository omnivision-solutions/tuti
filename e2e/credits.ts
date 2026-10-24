import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pg from "pg";

/** Spends what's left of the project's AI credits, as if its AI had used them (journeys have no other way to). */
export async function spendCredits(slug: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    // Its free credits too, and they count as given (every project gets them once).
    await client.query(`UPDATE ai_credit_grant SET remaining = 0 WHERE "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]);
    await client.query(`UPDATE project SET "freeCreditsGrantedAt" = COALESCE("freeCreditsGrantedAt", now() AT TIME ZONE 'UTC') WHERE slug = $1`, [slug]);
  } finally {
    await client.end();
  }
}

/** Gives the project credits with the operator's script (scripts/credits.mjs). */
export async function grantCredits(slug: string, credits: number, days = 0) {
  const { stdout } = await promisify(execFile)("node", ["scripts/credits.mjs", "grant", slug, String(credits), String(days), "e2e"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL },
  });
  return stdout.trim();
}
