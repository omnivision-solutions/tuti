// Maintainers only: a one-time link that signs a browser in as an account, to see what a customer sees (support).
// Run against the deployment's database (DATABASE_URL) and its APP_URL, e.g. with the maintainers' Infisical:
//
//   infisical run --env=prod --path=/web -- node scripts/sign-in-as.mjs <email>
//
// The link works once, for 10 minutes, on the app's host (lib/support-sign-in.ts). Open it in a private window: it
// replaces that browser's session, and the account's session ends when the window closes (at most a day).
// What you do there, you do as them.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !process.env.DATABASE_URL || !process.env.APP_URL) {
  console.error("Usage: DATABASE_URL=… APP_URL=… node scripts/sign-in-as.mjs <email>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(`SELECT id, name FROM "user" WHERE lower(email) = $1`, [email]);
  if (!rows[0]) {
    console.error(`No account with the email ${email}`);
    process.exit(1);
  }
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO verification (id, identifier, value, "expiresAt", "updatedAt") VALUES ($1, $2, $3, now() + interval '10 minutes', now())`,
    [randomUUID(), `support-sign-in:${createHash("sha256").update(token).digest("hex")}`, rows[0].id],
  );
  const link = new URL("/api/auth/support/sign-in", new URL(process.env.APP_URL).origin);
  link.searchParams.set("token", token);
  console.log(`Signs in as ${rows[0].name} <${email}>, once, for 10 minutes:\n${link}`);
} finally {
  await client.end();
}
