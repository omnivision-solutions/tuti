import pg from "pg";

/**
 * Sets when a project's published changelog entries were published: `day` (an SQL expression of `number`, a date), a second
 * an entry apart so they keep their order. Journeys can't wait for months to pass.
 */
export async function publishedOn(slug: string, day: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE changelog_entry SET "publishedAt" = (${day})::timestamptz + make_interval(secs => number)
       WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND "publishedAt" IS NOT NULL`,
      [slug],
    );
  } finally {
    await client.end();
  }
}

/** Sets a changelog entry's stored text as is, bypassing a save's checks (as a newer release's save might leave it). */
export async function setEntryContent(slug: string, number: number, content: unknown): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE changelog_entry SET content = $3::jsonb WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND number = $2`,
      [slug, number, JSON.stringify(content)],
    );
  } finally {
    await client.end();
  }
}

/** Links a pull request to a changelog entry, as the running draft does (journeys have no faster way to). */
export async function linkPullRequest(slug: string, number: number, pr: { repo: string; number: number; title: string }): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO changelog_entry_pull_request ("entryId", url, repo, number, title)
       SELECT id, $3, $4, $5, $6 FROM changelog_entry WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND number = $2`,
      [slug, number, `https://github.com/${pr.repo}/pull/${pr.number}`, pr.repo, pr.number, pr.title],
    );
  } finally {
    await client.end();
  }
}
