import pg from "pg";

/** Amazon SES (the fake, see global-setup.ts) finds a domain's DKIM records, as it would once the team adds them. */
export async function verifySesDomain(domain: string) {
  const response = await fetch(`${process.env.E2E_SES_URL}/_fake/verify?domain=${encodeURIComponent(domain)}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`SES (the fake) doesn't have ${domain}`);
  }
}

/** A permanent bounce of one of the project's emails, as SES reports it through SNS to the server's /api/email/events. */
export async function sesBounce(serverUrl: string, projectId: string) {
  const event = { eventType: "Bounce", mail: { messageId: crypto.randomUUID(), timestamp: new Date().toISOString(), tags: { project: [projectId] } }, bounce: { bounceType: "Permanent" } };
  const signed = await (await fetch(`${process.env.E2E_SES_URL}/_fake/sns`, { method: "POST", body: JSON.stringify(event) })).text();
  const response = await fetch(`${serverUrl}/api/email/events`, { method: "POST", body: signed });
  if (!response.ok) {
    throw new Error(`The server refused the bounce: ${response.status}`);
  }
}

/** Someone marked one of the project's emails as spam, as SES's complaint leaves it (journeys send no real email to complain about). */
export async function sesComplaint(slug: string, email: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`INSERT INTO email_block ("projectId", email) SELECT id, $2 FROM project WHERE slug = $1`, [slug, email.toLowerCase()]);
  } finally {
    await client.end();
  }
}
