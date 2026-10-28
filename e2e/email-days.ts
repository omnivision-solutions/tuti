import pg from "pg";

/** Uses up a new project's emails for today, as if SES had counted 200 sent (journeys have no other way to). */
export async function useTodaysEmails(slug: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO project_email_day ("projectId", day, sent) SELECT id, (now() AT TIME ZONE 'UTC')::date, 200 FROM project WHERE slug = $1
       ON CONFLICT ("projectId", day) DO UPDATE SET sent = 200`,
      [slug],
    );
  } finally {
    await client.end();
  }
}
