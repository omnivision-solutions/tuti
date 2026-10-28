import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { mailSubdomain } from "./inbound";
import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { addPortalReaders } from "./operations/portal";
import { call } from "./operations/run";
import { emailPasswordReset } from "./password-reset";
import { emailSignInLink } from "./sign-in-link";

/**
 * What a project sends its users comes from the project (docs/plan.md, Support inbox, item 13):
 * sign-in links, password resets, "<name> gave you access" and "shipped", from its updates@ address
 * under its SES tenant, Reply-To its support address while its inbox is on.
 */

const DOMAIN = "tuti.email";
const ses = await startSesFake();
afterAll(() => ses.close());
beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, value);
  }
  request.headers = {};
});
afterEach(() => vi.unstubAllEnvs());

const newAddress = () => `e2e-${randomUUID()}@example.com`;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const team = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  return { owner, project, team };
}

/** Each of the project's emails to a new address: the sign-in link, the password reset, the reader's, the shipped. */
async function sendAll(owner: TestUser, project: Awaited<ReturnType<typeof createProject>>, team: { actor: { kind: "user"; userId: string }; projectId: string }) {
  actAs(null);
  const signIn = newAddress();
  await emailSignInLink(project.slug, "/", form({ email: signIn }));

  const user = await signUp("Pat Portal");
  actAs(null);
  request.host = `${project.slug}.localhost:3100`;
  await emailPasswordReset(form({ email: user.email }));
  request.host = "";

  const reader = newAddress();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  actAs(owner);
  await call(addPortalReaders, team, { emails: [reader] });
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });

  const voter = await signUp("Val Voter");
  await prisma.user.update({ where: { id: voter.id }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voter.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await call(updatePost, team, { number: post.number, status: "completed" });

  const latest = (to: string, subject: RegExp) => mailbox.emails.filter((e) => e.to.includes(to) && subject.test(e.subject)).at(-1);
  return {
    signIn: latest(signIn, /^Sign in to/),
    reset: latest(user.email, /^Reset your password/),
    reader: latest(reader, /./),
    shipped: latest(voter.email, /^Done:/),
  };
}

test("from the project's updates@ address under its tenant; Reply-To its support address once its inbox is on", async () => {
  const { owner, project, team } = await setup();
  const subdomain = await mailSubdomain(project.id);
  const from = `"${project.name}" <updates@${subdomain}.${DOMAIN}>`;

  const before = await sendAll(owner, project, team);
  for (const email of Object.values(before)) {
    expect(email).toMatchObject({ from });
    expect(email!.headers["x-ses-tenant"]).toBe(`tuti-test-${project.id}`);
    expect(email!.headers["x-ses-message-tags"]).toBe(`project=${project.id}`);
  }
  // Inbox off: as before (the reader's goes back to who added them; the rest have none).
  expect(before.reader!.replyTo).toContain(owner.email);
  expect(before.signIn!.replyTo).toBeFalsy();
  // One-click unsubscribe as before.
  expect(before.shipped!.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");

  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  const after = await sendAll(owner, project, team);
  for (const email of Object.values(after)) {
    expect(email).toMatchObject({ from });
    expect(email!.replyTo).toContain(`support@${subdomain}.${DOMAIN}`);
  }
});

test("from updates@ the team's own domain once SES has it verified", async () => {
  const { owner, project, team } = await setup();
  const domain = `${project.slug}.example.com`;
  await prisma.emailDomain.create({ data: { projectId: project.id, domain, address: `support@${domain}`, dkimTokens: [], verifiedAt: new Date() } });
  ses.identities.set(domain, { tags: { "tuti-project": project.id }, tokens: [], configurationSet: "tuti-test", verified: true });

  for (const email of Object.values(await sendAll(owner, project, team))) {
    expect(email).toMatchObject({ from: `"${project.name}" <updates@${domain}>` });
  }
  expect(ses.tenants.get(`tuti-test-${project.id}`)!.resources).toContain(`arn:aws:ses:us-east-1:000000000000:identity/${domain}`);
});

test("without SUPPORT_EMAIL_DOMAIN, all of it comes from EMAIL_FROM as before", async () => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "");
  const { owner, project, team } = await setup();
  const sent = await sendAll(owner, project, team);
  for (const email of Object.values(sent)) {
    expect(email!.from).toBe('"Tuti Test" <test@example.com>');
    expect(email!.headers["x-ses-tenant"]).toBeUndefined();
  }
  expect(sent.reader!.replyTo).toContain(owner.email);
});

test("on a server selling plans, shipped emails wait for the project's approval; sign-in links don't", async () => {
  vi.stubEnv("PLANS", "on");
  const { owner, project, team } = await setup();
  // A plan with private portals, so readers can be added.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "BUSINESS" } });
  const sent = await sendAll(owner, project, team);
  expect(sent.signIn).toBeDefined();
  expect(sent.reset).toBeDefined();
  expect(sent.shipped).toBeUndefined();
  // Still due: the cron brings it back once the project is approved.
  expect(await prisma.post.findFirst({ where: { projectId: project.id, shippedEmailsDueAt: { not: null } } })).not.toBeNull();
});

test("readers are added even when the project's sender can't be set up; the email is what fails", async () => {
  const { owner, project, team } = await setup();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  ses.failing.add("/v2/email/tenants/resources");
  actAs(owner);
  const reader = newAddress();
  expect(await call(addPortalReaders, team, { emails: [reader] })).toEqual({ added: [reader], emailed: 0 });
  ses.failing.clear();
});
