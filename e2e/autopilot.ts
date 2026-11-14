import { createHmac, randomUUID } from "node:crypto";

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

/** Sets a pull request's (`number`) state, as if its job were queued or under way (`ANALYSING`), done (`READY`) or failed (`FAILED`, saying why: `reason`), now. */
export async function setPullRequestState(slug: string, number: number, state: "ANALYSING" | "READY" | "FAILED", reason = "") {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE code_change c SET state = $3, reason = $4, "updatedAt" = now() AT TIME ZONE 'UTC' FROM project p WHERE p.id = c."projectId" AND p.slug = $1 AND c.number = $2`,
      [slug, number, state, reason],
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

/**
 * As if Autopilot went to apply the project's applied updates of `kind` by itself and couldn't tell whether they went
 * out (a database blip as it saved): marked unsure, credited to nobody.
 */
export async function markUnsure(slug: string, kind: "RESOLVES" | "ARTICLE_EDIT") {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE code_change_action a SET payload = coalesce(a.payload, '{}'::jsonb) || '{"unsure": true}'::jsonb, "decidedById" = NULL
       FROM code_change c JOIN project p ON p.id = c."projectId"
       WHERE a."codeChangeId" = c.id AND p.slug = $1 AND a.status = 'APPLIED' AND a.kind = $2::"CodeChangeActionKind"`,
      [slug, kind],
    );
  } finally {
    await client.end();
  }
}

/** The statuses of project `slug`'s article edits, by their pull request's number. */
export async function editStatuses(slug: string): Promise<Record<number, string>> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ number: number; status: string }>(
      `SELECT c.number, a.status FROM code_change_action a
       JOIN code_change c ON c.id = a."codeChangeId" JOIN project p ON p.id = c."projectId"
       WHERE p.slug = $1 AND a.kind = 'ARTICLE_EDIT'`,
      [slug],
    );
    return Object.fromEntries(rows.map((row) => [row.number, row.status]));
  } finally {
    await client.end();
  }
}

/**
 * Where project `slug`'s new article's draft `title` goes (docs/plan.md, D5), as the analysis would say: in collection
 * `collection` (by name) after article `after` (by title; null: first), or in a new collection `newCollection`.
 */
export async function placeDraft(slug: string, title: string, place: { collection: string; after: string | null } | { newCollection: string; icon: string | null }) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    let json: object = place;
    if ("collection" in place) {
      const ids = await client.query<{ collection: string; after: string | null }>(
        `SELECT c.id AS collection, (SELECT a.id FROM article a WHERE a."collectionId" = c.id AND a.title = $3) AS after
         FROM collection c JOIN project p ON p.id = c."projectId" WHERE p.slug = $1 AND c.name = $2`,
        [slug, place.collection, place.after],
      );
      json = ids.rows[0]!;
    }
    await client.query(
      `UPDATE code_change_action a SET payload = a.payload || jsonb_build_object('place', $3::jsonb)
       FROM code_change c JOIN project p ON p.id = c."projectId"
       WHERE a."codeChangeId" = c.id AND p.slug = $1 AND a.kind = 'NEW_ARTICLE' AND a.payload->>'title' = $2`,
      [slug, title, JSON.stringify(json)],
    );
  } finally {
    await client.end();
  }
}

/** The titles of the live articles in project `slug`'s collection `name`, in order (drafts too). */
export async function articlesIn(slug: string, name: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const rows = await client.query<{ title: string }>(
      `SELECT a.title FROM article a JOIN collection c ON c.id = a."collectionId" JOIN project p ON p.id = c."projectId"
       WHERE p.slug = $1 AND c.name = $2 AND a."deletedAt" IS NULL ORDER BY a."order", a.title`,
      [slug, name],
    );
    return rows.rows.map((row) => row.title);
  } finally {
    await client.end();
  }
}

/** A merged pull request whose new article's draft `title` goes out by itself (scheduled in an hour, as with Drafts on): its update's id. */
export async function scheduledDraft(slug: string, title: string): Promise<string> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `WITH change AS (
         INSERT INTO code_change (id, "projectId", "repoId", repo, number, url, title, author, "mergedAt", state, "updatedAt")
         SELECT gen_random_uuid()::text, id, 1, 'acme/app', 7, 'https://github.com/acme/app/pull/7', 'Exports', 'octo', now(), 'READY', now()
         FROM project WHERE slug = $1 RETURNING id
       )
       INSERT INTO code_change_action (id, "codeChangeId", kind, probability, status, "dueAt", payload)
       SELECT gen_random_uuid()::text, change.id, 'NEW_ARTICLE', 0.95, 'SCHEDULED', now() + interval '1 hour', jsonb_build_object('title', $2::text, 'body', 'Pick CSV.')
       FROM change RETURNING id`,
      [slug, title],
    );
    return rows[0]!.id;
  } finally {
    await client.end();
  }
}

/**
 * A post's progress update set waiting for the team (not stopped by anyone) or going out by itself (as Autopilot's hold
 * puts it), whichever it is now.
 */
export async function setPostUpdate(slug: string, title: string, status: "PENDING" | "SCHEDULED") {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE code_change_action a SET status = $3::"CodeChangeActionStatus", "waitReason" = NULL, "decidedById" = NULL,
         "dueAt" = CASE WHEN $3 = 'SCHEDULED' THEN (now() AT TIME ZONE 'UTC') + interval '1 day' END
       FROM post p JOIN project pr ON pr.id = p."projectId"
       WHERE a."postId" = p.id AND p.title = $2 AND pr.slug = $1 AND a.kind = 'MOVES_FORWARD' AND a.status IN ('PENDING', 'SCHEDULED')`,
      [slug, title, status],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

/** Adds an account (by email) to a project's team as an admin, without an invite. */
export async function joinTeam(slug: string, email: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `INSERT INTO team_member (id, "projectId", "userId", role) SELECT $1, p.id, u.id, 'ADMIN' FROM project p, "user" u WHERE p.slug = $2 AND u.email = $3`,
      [randomUUID(), slug, email],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}
