import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { conversationCompanies } from "./inbox-companies";
import { upsertProjectUser } from "./project-users";

test("an Inbox row's company: a user's own; one with their address verified (the oldest user's when several share it); none unverified, nor for the team", async () => {
  const owner = await signUp("Owner");
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  const project = await createProject(owner);
  const projectId = project.id;
  // Two users share an address, the older at Acme; one more at Globex; and one with the team owner's address.
  // (The newer one stored first: the older wins by when it came, not by the order rows come back in.)
  await upsertProjectUser(projectId, "ada-later", { name: "Ada", email: "e2e-shared@example.com", properties: { company: "Initech" } });
  const ada = await upsertProjectUser(projectId, "ada", { name: "Ada", email: "e2e-shared@example.com", properties: { company: "Acme" } });
  await prisma.ssoIdentity.updateMany({ where: { projectId, externalId: "ada-later" }, data: { createdAt: new Date(Date.now() + 60_000) } });
  await upsertProjectUser(projectId, "cy", { name: "Cy", email: "e2e-cy@example.com", properties: { company: "Globex" } });
  await upsertProjectUser(projectId, "team-twin", { name: "Twin", email: owner.email, properties: { company: "Hooli" } });

  const sso = await prisma.user.findUniqueOrThrow({ where: { id: ada }, select: { email: true, emailVerified: true, ssoIdentity: { select: { properties: true } } } });
  const row = (id: string, fields: Partial<Parameters<typeof conversationCompanies>[1][number]>) => ({ id, userId: null, email: null, emailVerified: false, user: null, ...fields });
  const companies = await conversationCompanies(projectId, [
    // A user of the project: their own.
    row("own", { userId: ada, user: sso }),
    // Only an address, verified, that two users share: the older one's.
    row("shared", { email: "e2e-shared@example.com", emailVerified: true }),
    // The same, unverified: none.
    row("unverified", { email: "e2e-cy@example.com", emailVerified: false }),
    // The team's own account, whose address a user also has: none.
    row("team", { userId: owner.id, user: { email: owner.email, emailVerified: true, ssoIdentity: null } }),
  ]);
  expect(Object.fromEntries(companies)).toEqual({ own: "Acme", shared: "Acme" });
});
