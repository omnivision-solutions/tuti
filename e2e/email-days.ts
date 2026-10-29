import pg from "pg";

/**
 * Sets a project's email for today (journeys have no other way to send hundreds): what SES counted
 * (`sent`, `bounced`) and what its daily cap has given out (`claimed`). Its id.
 */
export async function setTodaysEmails(slug: string, { sent = 0, bounced = 0, claimed = 0 }: { sent?: number; bounced?: number; claimed?: number }): Promise<string> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ projectId: string }>(
      `INSERT INTO project_email_day ("projectId", day, sent, bounced, claimed) SELECT id, (now() AT TIME ZONE 'UTC')::date, $2, $3, $4 FROM project WHERE slug = $1
       ON CONFLICT ("projectId", day) DO UPDATE SET sent = $2, bounced = $3, claimed = $4 RETURNING "projectId"`,
      [slug, sent, bounced, claimed],
    );
    return rows[0]!.projectId;
  } finally {
    await client.end();
  }
}
