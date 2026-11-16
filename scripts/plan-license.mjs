// The operator only (Tuti's cloud): plan licenses Tuti hands out itself (source "tuti"), as AppSumo's webhook makes
// its own: a plan from the billing file for a project, with that plan's AI credits every month (the hourly
// license-credits job), until revoked. For our own projects, partners or giveaways. Run against the server's
// database (DATABASE_URL); with BILLING_CONFIG set, the plan is checked against that file:
//
//   DATABASE_URL=… node scripts/plan-license.mjs issue <account email> <plan> [project slug] [note]
//   DATABASE_URL=… node scripts/plan-license.mjs revoke <license key>
//
// issue   gives the account a license (on its Licenses page). With a project slug it's assigned there at once,
//         replacing a plan set by hand (gone for good: unassigned or revoked, the project is on the default plan);
//         refused unless the account owns or administers the project, and while the project pays through Stripe or holds a license. A first Stripe payment still
//         processing doesn't show here (Assign in the app asks Stripe): check the customer in Stripe first.
// revoke  takes it back: its project returns to its own plan and the credits it gave that are left go.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

const [command, ...args] = process.argv.slice(2);
const usage = () => {
  console.error("Usage: DATABASE_URL=… node scripts/plan-license.mjs issue <account email> <plan> [project slug] [note]\n       DATABASE_URL=… node scripts/plan-license.mjs revoke <license key>");
  process.exit(1);
};
if (!process.env.DATABASE_URL || !((command === "issue" && args.length >= 2) || (command === "revoke" && args.length === 1))) {
  usage();
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/** Stripe's webhook's lock for the project, then its row: the app's order (applyPlanLicense). */
const lockProject = async (id) => {
  await client.query("SELECT pg_advisory_xact_lock(6, hashtext($1))", [id]);
  return (await client.query(`SELECT "planStatus", "badgeAddOn" FROM project WHERE id = $1 FOR UPDATE`, [id])).rows[0];
};

class Refused extends Error {}

try {
  await client.query("BEGIN");
  if (command === "issue") {
    const [email, plan, slug, ...note] = args;
    const config = process.env.BILLING_CONFIG?.trim();
    if (config && !JSON.parse(readFileSync(config, "utf8")).plans.some((one) => one.key === plan)) {
      throw new Refused(`no plan ${plan} in ${config}`);
    }
    const user = (await client.query(`SELECT id FROM "user" WHERE lower(email) = lower($1)`, [email])).rows[0];
    if (!user) {
      throw new Refused(`no account ${email}`);
    }
    const project = slug ? (await client.query("SELECT id FROM project WHERE slug = $1", [slug])).rows[0] : null;
    if (slug && !project) {
      throw new Refused(`no project ${slug}`);
    }
    if (project) {
      // Assign's rule in the app: the holder owns or administers it (a mistyped slug or email is caught here).
      if (!(await client.query(`SELECT 1 FROM team_member WHERE "projectId" = $1 AND "userId" = $2 AND role IN ('OWNER', 'ADMIN')`, [project.id, user.id])).rowCount) {
        throw new Refused(`${email} isn't an owner or admin of ${slug}`);
      }
      if ((await lockProject(project.id)).planStatus !== null) {
        throw new Refused(`${slug} pays for a plan through Stripe; cancel that first`);
      }
      if ((await client.query(`SELECT 1 FROM plan_license WHERE "projectId" = $1`, [project.id])).rowCount) {
        throw new Refused(`${slug} has a license already`);
      }
    }
    const key = `tuti-${randomUUID()}`;
    await client.query(
      `INSERT INTO plan_license (id, source, "externalKey", plan, "userId", "projectId", metadata, "claimedAt", "assignedAt", "updatedAt")
       VALUES ($1, 'tuti', $2, $3, $4, $5, $6, (now() AT TIME ZONE 'UTC'), CASE WHEN $5::text IS NULL THEN NULL ELSE (now() AT TIME ZONE 'UTC') END, (now() AT TIME ZONE 'UTC'))`,
      [randomUUID(), key, plan, user.id, project?.id ?? null, JSON.stringify(note.length ? { note: note.join(" ") } : {})],
    );
    if (project) {
      await client.query(`UPDATE project SET "planKey" = $2 WHERE id = $1`, [project.id, plan]);
    }
    console.log(`issue: ${key} (${plan}) for ${email}${slug ? `, on ${slug}; its credits come within the hour` : ""}`);
  } else {
    const [key] = args;
    const license = (await client.query(`SELECT id, "projectId", "revokedAt" FROM plan_license WHERE source = 'tuti' AND "externalKey" = $1 FOR UPDATE`, [key])).rows[0];
    if (!license) {
      throw new Refused(`no license ${key}`);
    }
    if (license.revokedAt) {
      // Done already: its project may have had a plan set since, which a second revoke mustn't clear.
      throw new Refused(`${key} was revoked already`);
    }
    if (license.projectId && (await lockProject(license.projectId)).badgeAddOn) {
      throw new Refused("its project has the Powered by tuti add-on: hide the badge again from Billing first");
    }
    await client.query(`UPDATE plan_license SET "revokedAt" = (now() AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE id = $1`, [license.id]);
    // Under each project's row lock, as charges take it (chargeCredits).
    await client.query(`SELECT id FROM project WHERE id IN (SELECT "projectId" FROM ai_credit_grant WHERE "planLicenseId" = $1 AND remaining > 0) ORDER BY id FOR UPDATE`, [license.id]);
    await client.query(`UPDATE ai_credit_grant SET "takenBack" = "takenBack" + remaining, remaining = 0 WHERE "planLicenseId" = $1 AND remaining > 0`, [license.id]);
    if (license.projectId) {
      await client.query(`UPDATE project SET "planKey" = NULL WHERE id = $1 AND "planStatus" IS NULL`, [license.projectId]);
    }
    console.log(`revoke: ${key}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  if (!(error instanceof Refused)) {
    throw error;
  }
  console.error(`${command}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
