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
