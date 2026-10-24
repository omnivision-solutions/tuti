// The operator only (Tuti's cloud, AI_CREDITS=on): gives a project AI credits by hand, e.g. for a
// support case, until there's a checkout. Run against the server's database (DATABASE_URL):
//
//   DATABASE_URL=… node scripts/credits.mjs grant <project slug> <credits> [days] [note]
//
// Without days (or 0) they last for good. Timestamps are UTC, like the app's.
// The project's debt, if any, is paid from them with its next AI request.
import { randomUUID } from "node:crypto";

import pg from "pg";

const [command, slug, amount, days = "0", ...note] = process.argv.slice(2);
const credits = Number(amount);
const lasts = Number(days);
if (command !== "grant" || !slug || !(credits > 0) || !Number.isInteger(lasts) || lasts < 0 || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=… node scripts/credits.mjs grant <project slug> <credits> [days] [note]");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(
    `INSERT INTO ai_credit_grant (id, "projectId", source, credits, remaining, "expiresAt", note)
     SELECT $1, id, 'MANUAL', $2, $2, CASE WHEN $3::int > 0 THEN (now() AT TIME ZONE 'UTC') + make_interval(days => $3::int) END, $4 FROM project WHERE slug = $5`,
    [randomUUID(), credits, lasts, note.join(" "), slug],
  );
  console.log(rowCount ? `grant: ${credits} credits for ${slug}${lasts > 0 ? `, for ${lasts} days` : ", for good"}` : `grant: no project ${slug}`);
} finally {
  await client.end();
}
