// Maintainers only: licences on Tuti's licence server (tuti.so), for support. Licences are bought on
// tuti.so/license with Stripe; one bought there is on while its subscription is live, so cancel or
// refund that in Stripe instead (Stripe's next event about it would turn it back on).
// Run against tuti.so's database (DATABASE_URL), e.g. with the maintainers' Infisical:
//
//   infisical run --env=prod --path=/web -- node scripts/license.mjs activate <installation id> <project id>
//
//   activate  sells the licence (or turns a cancelled one back on); the installation's next check gets a key
//   cancel    stops renewals, so the installation's key lapses within a month and the badge comes back
//   reset     forgets which installation holds it (support's answer when the wrong copy of a cloned
//             installation kept renewing): the next installation to claim it gets it
import { randomUUID } from "node:crypto";

import pg from "pg";

const [command, installation, project] = process.argv.slice(2);
const QUERIES = {
  activate: [
    `INSERT INTO license (id, "installationId", "projectId") VALUES ($3, $1, $2)
     ON CONFLICT ("installationId", "projectId") DO UPDATE SET active = true`,
    [installation, project, randomUUID()],
  ],
  cancel: [`UPDATE license SET active = false WHERE "installationId" = $1 AND "projectId" = $2`, [installation, project]],
  reset: [
    `UPDATE license SET generation = 0, "requestId" = NULL WHERE "installationId" = $1 AND "projectId" = $2`,
    [installation, project],
  ],
};
if (!QUERIES[command] || !installation || !project || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=… node scripts/license.mjs <activate|cancel|reset> <installation id> <project id>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(...QUERIES[command]);
  console.log(rowCount ? `${command}: done` : `${command}: no licence for that installation and project`);
} finally {
  await client.end();
}
