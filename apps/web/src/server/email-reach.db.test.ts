import { prisma } from "@tuti/db";
import { audienceReach, postAudience } from "@tuti/jobs";
import { expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { emailReach } from "./post-lists";

/**
 * Who a post's email reaches, and why not, by the one rule: the shipped and reply emails go by it
 * (postAudience), a portal board's Get updates says it (emailReach). Each case through all three, so
 * they can't disagree.
 */
test("a post's email reaches a confirmed or SSO address, not the team, the unsubscribed, the unconfirmed, a missing address or a private portal's outsiders", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const person = async (name: string, data: { emailVerified?: boolean } = {}) => {
    const user = await signUp(name);
    return data.emailVerified === undefined ? user : prisma.user.update({ where: { id: user.id }, data });
  };
  const confirmed = await person("Confirmed", { emailVerified: true });
  const unconfirmed = await person("Unconfirmed", { emailVerified: false });
  const teammate = await person("Teammate", { emailVerified: true });
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  const unsubscribed = await person("Unsubscribed", { emailVerified: true });
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: unsubscribed.id } });
  // Its own app's users: the address it gave (the account's is a placeholder, not verified), or none.
  const fromSso = await person("From SSO", { emailVerified: false });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-1", userId: fromSso.id, email: "e2e-sso@example.com" } });
  const ssoNoEmail = await person("SSO without email", { emailVerified: false });
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-2", userId: ssoNoEmail.id } });
  // Another project's app's user: a placeholder that isn't confirmed.
  const elsewhere = await person("Elsewhere", { emailVerified: false });
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-3", userId: elsewhere.id, email: "e2e-elsewhere@example.com" } });

  const ids = [confirmed, unconfirmed, teammate, unsubscribed, fromSso, ssoNoEmail, elsewhere].map((user) => user.id);
  /** Each person's reach, checked against who postAudience emails and what the board reads for them. */
  const statuses = async () => {
    const settings = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { portalAccess: true, plan: true } });
    const reach = await audienceReach(project.id, settings, ids);
    const audience = await postAudience(project.id, settings, ids);
    expect(audience.map((recipient) => recipient.id).sort()).toEqual(ids.filter((id) => reach.get(id)?.status === "emailed").sort());
    for (const id of ids) {
      expect(await emailReach(project.id, id)).toEqual(reach.get(id));
    }
    return ids.map((id) => reach.get(id)!.status);
  };

  expect(await statuses()).toEqual(["emailed", "unconfirmed", "team", "optedOut", "emailed", "noAddress", "unconfirmed"]);
  const settings = { portalAccess: "PUBLIC", plan: "FREE" as const };
  expect((await audienceReach(project.id, settings, [fromSso.id])).get(fromSso.id)).toMatchObject({ address: "e2e-sso@example.com" });

  // A private portal: only its SSO users and the readers the team added (verified) still hear.
  const reader = await person("Reader", { emailVerified: true });
  // A domain's: everyone with a verified address there (not one under it).
  const atDomain = await prisma.user.update({ where: { id: (await signUp("At the domain")).id }, data: { email: "e2e-colleague@readers.example.com", emailVerified: true } });
  const subdomain = await prisma.user.update({ where: { id: (await signUp("Under it")).id }, data: { email: "e2e-other@sub.readers.example.com", emailVerified: true } });
  ids.push(reader.id, atDomain.id, subdomain.id);
  await prisma.portalReader.create({ data: { projectId: project.id, email: (await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).email.toUpperCase() } });
  await prisma.portalReader.create({ data: { projectId: project.id, email: "@readers.example.com" } });
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  expect(await statuses()).toEqual(["notReader", "notReader", "team", "optedOut", "emailed", "noAddress", "notReader", "emailed", "emailed", "notReader"]);
  // On a plan without private portals, it's the team's only: nobody else hears.
  vi.stubEnv("PLANS", "on");
  try {
    expect(await statuses()).toEqual(["notReader", "notReader", "team", "optedOut", "notReader", "notReader", "notReader", "notReader", "notReader", "notReader"]);
  } finally {
    vi.unstubAllEnvs();
  }
});
