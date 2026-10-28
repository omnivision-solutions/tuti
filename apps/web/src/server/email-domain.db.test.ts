import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";

import { mailSubdomain, supportAddress } from "./inbound";
import { replyToConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { checkEmailDomainOperation, getSupportSettings, removeEmailDomain, setEmailDomain } from "./operations/support";

/** Replies by email from the team's own domain (docs/plan.md, Support inbox, item 11; Pro), verified by Amazon SES. */

const DOMAIN = "tuti.email";
const log = { info: () => {}, warn: () => {} };
const ses = await startSesFake();
afterAll(() => ses.close());
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const subdomain = await mailSubdomain(project.id);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const kim = `e2e-kim-${project.slug}@example.com`;
  await postEmail(rawEmail({ from: kim, to: supportAddress(subdomain, DOMAIN), subject: "Invoice missing" }), { recipient: supportAddress(subdomain, DOMAIN) });
  /** Replies, emailed a minute on: the From of the latest email to Kim. */
  const reply = async (body: string) => {
    await call(replyToConversation, team, { number: 1, body });
    await prisma.$executeRaw`UPDATE "conversation_message" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "projectId" = ${project.id}`;
    await handlers.sendConversationReplies({}, log);
    return mailbox.emails.filter((email) => email.to.includes(kim)).at(-1)!;
  };
  return { project, subdomain, team, reply };
}

test("replies come from the team's address once SES finds its DKIM records, under the project's tenant", async () => {
  const { project, subdomain, team, reply } = await setup();
  const domain = `${project.slug}.example.com`;
  const settings = await call(setEmailDomain, team, { address: `Support@${domain}` });
  // The 3 CNAMEs SES gave, for the team's DNS; SES has the domain for this project, its mail naming the configuration set.
  expect(settings.email!.ownDomain).toMatchObject({ included: true, address: `support@${domain}`, verified: false });
  expect(settings.email!.ownDomain!.records).toEqual(
    ses.identities.get(domain)!.tokens.map((token) => ({ type: "CNAME", name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com` })),
  );
  expect(ses.identities.get(domain)).toMatchObject({ tags: { "tuti-project": project.id }, configurationSet: "tuti-test" });

  // Not verified yet: from the project's support address.
  expect((await reply("First")).from).toBe(`"Olive Owner at ${project.name}" <support@${subdomain}.${DOMAIN}>`);
  expect((await call(checkEmailDomainOperation, team, {})).email!.ownDomain).toMatchObject({ verified: false, error: null });

  ses.identities.get(domain)!.verified = true;
  expect((await call(checkEmailDomainOperation, team, {})).email!.ownDomain).toMatchObject({ verified: true, error: null });
  const email = await reply("Second");
  expect(email.from).toBe(`"Olive Owner at ${project.name}" <support@${domain}>`);
  // Replies still come back to the conversation's own address.
  expect(email.replyTo).toContain(`@${subdomain}.${DOMAIN}`);
  const tenant = `tuti-test-${project.id}`;
  expect(email.headers["x-ses-tenant"]).toBe(tenant);
  expect(ses.tenants.get(tenant)!.resources).toContain(`arn:aws:ses:us-east-1:000000000000:identity/${domain}`);
});

test("a domain is one project's alone, and none SES has for anything else (or under it) can be taken", async () => {
  const { project, team } = await setup();
  const other = await setup();
  const domain = `${project.slug}.example.com`;
  await call(setEmailDomain, team, { address: `support@${domain}` });

  await expect(call(setEmailDomain, other.team, { address: `help@${domain}` })).rejects.toMatchObject({ status: 409, code: "domain_taken" });
  ses.identities.get(domain)!.verified = true;
  await call(checkEmailDomainOperation, team, {});
  await expect(call(setEmailDomain, other.team, { address: `help@${domain}` })).rejects.toMatchObject({ status: 409, code: "domain_taken" });
  // A domain SES has for something else, or one under it, sends as that: refused.
  ses.identities.set("operator.example.com", { tags: {}, tokens: [], configurationSet: undefined, verified: true });
  await expect(call(setEmailDomain, other.team, { address: "help@operator.example.com" })).rejects.toMatchObject({ status: 409 });
  await expect(call(setEmailDomain, other.team, { address: "help@mail.operator.example.com" })).rejects.toMatchObject({ status: 409 });
  // The support domain is everyone's.
  await expect(call(setEmailDomain, other.team, { address: `help@x.${DOMAIN}` })).rejects.toMatchObject({ status: 400 });
  expect(await prisma.emailDomain.findMany({ where: { projectId: other.project.id } })).toEqual([]);
});

test("checked again daily: one SES no longer has verified falls back to the support address, saying why", async () => {
  const { project, subdomain, team, reply } = await setup();
  const domain = `${project.slug}.example.com`;
  await call(setEmailDomain, team, { address: `support@${domain}` });
  ses.identities.get(domain)!.verified = true;
  await handlers.checkEmailDomains({}, log);
  expect((await reply("Verified")).from).toContain(`<support@${domain}>`);

  ses.identities.get(domain)!.verified = false;
  await handlers.checkEmailDomains({}, log);
  expect((await call(getSupportSettings, team, {})).email!.ownDomain).toMatchObject({ verified: false, error: expect.stringContaining("DKIM records") });
  expect((await reply("Fallen back")).from).toContain(`<support@${subdomain}.${DOMAIN}>`);
});

test("removing it has SES forget the domain, and replies come from the support address", async () => {
  const { project, subdomain, team, reply } = await setup();
  const domain = `${project.slug}.example.com`;
  await call(setEmailDomain, team, { address: `support@${domain}` });
  ses.identities.get(domain)!.verified = true;
  await call(checkEmailDomainOperation, team, {});
  // Sent from it: the project's tenant uses it, which SES won't delete it from under.
  expect((await reply("Before")).from).toContain(`<support@${domain}>`);

  expect((await call(removeEmailDomain, team, {})).email!.ownDomain).toMatchObject({ address: null, records: [] });
  expect(ses.identities.has(domain)).toBe(false);
  expect((await reply("After")).from).toContain(`<support@${subdomain}.${DOMAIN}>`);
});

test("on a server selling plans, it needs Pro; without SES it isn't offered", async () => {
  const { team } = await setup();
  vi.stubEnv("PLANS", "on");
  expect((await call(getSupportSettings, team, {})).email!.ownDomain).toMatchObject({ included: false });
  await expect(call(setEmailDomain, team, { address: "support@pro-only.example.com" })).rejects.toMatchObject({ status: 402 });

  vi.stubEnv("PLANS", "");
  vi.stubEnv("SES_REGION", "");
  expect((await call(getSupportSettings, team, {})).email!.ownDomain).toBeNull();
  await expect(call(setEmailDomain, team, { address: "support@no-ses.example.com" })).rejects.toMatchObject({ status: 409 });
});

test("removed and added back, the same domain is associated with the tenant again before its next email", async () => {
  const { project, team, reply } = await setup();
  const domain = `${project.slug}.example.com`;
  const tenant = `tuti-test-${project.id}`;
  await call(setEmailDomain, team, { address: `support@${domain}` });
  ses.identities.get(domain)!.verified = true;
  await call(checkEmailDomainOperation, team, {});
  await reply("Before");
  await call(removeEmailDomain, team, {});
  expect(ses.tenants.get(tenant)!.resources).not.toContain(`arn:aws:ses:us-east-1:000000000000:identity/${domain}`);

  await call(setEmailDomain, team, { address: `support@${domain}` });
  ses.identities.get(domain)!.verified = true;
  await call(checkEmailDomainOperation, team, {});
  expect((await reply("Again")).from).toContain(`<support@${domain}>`);
  expect(ses.tenants.get(tenant)!.resources).toContain(`arn:aws:ses:us-east-1:000000000000:identity/${domain}`);
});

test("nobody can hold a domain they don't own: unverified for a week it's let go, and an unverified one above doesn't block", async () => {
  const { project, team } = await setup();
  const other = await setup();
  const domain = `${project.slug}.example.com`;
  await call(setEmailDomain, team, { address: `support@${domain}` });
  // Someone else's subdomain of it: fine while it doesn't send.
  await call(setEmailDomain, other.team, { address: `help@help.${domain}` });
  await call(removeEmailDomain, other.team, {});

  await handlers.checkEmailDomains({}, log);
  expect(await prisma.emailDomain.count({ where: { projectId: project.id } })).toBe(1);
  await prisma.emailDomain.update({ where: { projectId: project.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  await handlers.checkEmailDomains({}, log);
  expect(await prisma.emailDomain.count({ where: { projectId: project.id } })).toBe(0);
  expect(ses.identities.has(domain)).toBe(false);
  await call(setEmailDomain, other.team, { address: `help@${domain}` });
});

test("a domain left in SES by a project since deleted can be taken", async () => {
  const gone = await setup();
  const { team, project } = await setup();
  const domain = `${gone.project.slug}.example.com`;
  await call(setEmailDomain, gone.team, { address: `support@${domain}` });
  await prisma.project.delete({ where: { id: gone.project.id } });

  await call(setEmailDomain, team, { address: `support@${domain}` });
  expect(ses.identities.get(domain)!.tags).toEqual({ "tuti-project": project.id });
});
