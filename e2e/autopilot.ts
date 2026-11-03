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
          `UPDATE code_change_action a SET "dueAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
           FROM code_change c JOIN project p ON p.id = c."projectId"
           WHERE a."codeChangeId" = c.id AND p.slug = $1 AND a.status = 'SCHEDULED'`,
          [slug],
        );
      }
      // Its notices as if ten minutes passed (nothing else merged meanwhile): its email goes in this minute.
      if (emailNow) {
        await client.query(
          `UPDATE autopilot_notice n SET "createdAt" = (now() AT TIME ZONE 'UTC') - interval '11 minutes'
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

/** Marks the edit a pull request (`number`) wrote out of date, as the review shows one written on an article that changed since. */
export async function markOutOfDate(slug: string, number: number) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE code_change_action a SET status = 'STALE'
       FROM code_change c JOIN project p ON p.id = c."projectId"
       WHERE a."codeChangeId" = c.id AND p.slug = $1 AND c.number = $2 AND a.kind = 'ARTICLE_EDIT' AND a.status = 'PENDING'`,
      [slug, number],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

/**
 * Makes the edit a pull request (`number`) wrote look like one the previous release wrote: not saved into its article's
 * unpublished changes (no tagged revision, and the changes gone).
 */
export async function asPreviousRelease(slug: string, number: number) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; articleId: string }>(
      `SELECT a.id, a."articleId" FROM code_change_action a JOIN code_change c ON c.id = a."codeChangeId" JOIN project p ON p.id = c."projectId"
       WHERE p.slug = $1 AND c.number = $2 AND a.kind = 'ARTICLE_EDIT'`,
      [slug, number],
    );
    expect(rows).toHaveLength(1);
    await client.query(`UPDATE article_revision SET "codeChangeActionId" = NULL WHERE "codeChangeActionId" = $1`, [rows[0]!.id]);
    await client.query(`DELETE FROM article_changes WHERE "articleId" = $1`, [rows[0]!.articleId]);
  } finally {
    await client.end();
  }
}

/** Sets a pull request's (`number`) state, as if its job were queued or under way (`ANALYSING`) or done (`READY`), now. */
export async function setPullRequestState(slug: string, number: number, state: "ANALYSING" | "READY") {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE code_change c SET state = $3, "updatedAt" = now() AT TIME ZONE 'UTC' FROM project p WHERE p.id = c."projectId" AND p.slug = $1 AND c.number = $2`,
      [slug, number, state],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

/** Turns Autopilot's analysis on or off for the project, as an owner does in Settings → Autopilot. */
export async function setAnalysis(slug: string, on: boolean) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE project SET "analyseCodeChanges" = $2 WHERE slug = $1`, [slug, on]);
  } finally {
    await client.end();
  }
}
