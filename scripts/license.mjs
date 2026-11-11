// Maintainers only: licences on Tuti's licence server (tuti.so), for support. Licences are bought on
// tuti.so/app/license with Stripe; one bought there is on while its subscription is live, so cancel or
// refund that in Stripe instead (Stripe's next event about it would turn it back on).
// Run against tuti.so's database (DATABASE_URL), e.g. with the maintainers' Infisical:
//
//   infisical run --env=prod --path=/web -- node scripts/license.mjs activate <installation id> <project id>
//
//   activate  sells the licence (or turns a cancelled one back on); the installation's next check gets a key
//   cancel    stops renewals, so the installation's key lapses within a month and the badge comes back
//   reset     forgets which installation holds it (support's answer when the wrong copy of a cloned
//             installation kept renewing): the next copy to claim it gets it (any installation, for one activated here)
//             --forget-claim also clears its claim hash, so any installation may claim it: for one bought with a
//             claim no installation can match; check it's the buyer asking first
import { randomUUID } from "node:crypto";

import pg from "pg";

const args = process.argv.slice(2);
const forgetClaim = args.includes("--forget-claim");
const [command, installation, project] = args.filter((arg) => arg !== "--forget-claim");
const QUERIES = {
  activate: [
    `INSERT INTO license (id, "installationId", "projectId") VALUES ($3, $1, $2)
     ON CONFLICT ("installationId", "projectId") DO UPDATE SET active = true`,
    [installation, project, randomUUID()],
  ],
  cancel: [`UPDATE license SET active = false WHERE "installationId" = $1 AND "projectId" = $2`, [installation, project]],
  reset: [
    `UPDATE license SET generation = 0, "requestId" = NULL${forgetClaim ? ', "claimHash" = NULL' : ""} WHERE "installationId" = $1 AND "projectId" = $2`,
    [installation, project],
  ],
};
if (!QUERIES[command] || !installation || !project || !process.env.DATABASE_URL || (forgetClaim && command !== "reset")) {
  console.error("Usage: DATABASE_URL=… node scripts/license.mjs <activate|cancel|reset [--forget-claim]> <installation id> <project id>");
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
