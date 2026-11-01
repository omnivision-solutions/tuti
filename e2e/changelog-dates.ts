import pg from "pg";

/** Moves a project's published changelog entries back `months` (an SQL expression of `number`) from when they were published: journeys can't wait for a month to pass. */
export async function backdate(slug: string, months: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE changelog_entry SET "publishedAt" = "publishedAt" - make_interval(months => ${months})
       WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND "publishedAt" IS NOT NULL`,
      [slug],
    );
  } finally {
    await client.end();
  }
}
