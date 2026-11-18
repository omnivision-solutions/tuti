import pg from "pg";

/** A query on the journeys' database, for what no screen can set up or show (a column the previous release wrote, a plan). */
export async function query(sql: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}
