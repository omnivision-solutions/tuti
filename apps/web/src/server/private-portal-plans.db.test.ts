import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle } from "./operations/docs";
import { createGroup, deleteGroup, updateGroup } from "./operations/groups";
import { addPortalReaders, updatePortal } from "./operations/portal";
import { call } from "./operations/run";
import { canReadPortal, readerOf } from "./portal-access";
import { upsertProjectUser } from "./project-users";

/**
 * Where plans are sold (docs/plan.md, Plans): a private portal, reader groups and readers by email are on
 * Business. On a lower plan nothing becomes more public: a private portal and content for groups are the
 * team's only until the plan is back, and nothing is deleted.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("PLANS", "on");
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const onPlan = (plan: "FREE" | "PRO" | "BUSINESS") => prisma.project.update({ where: { id: project.id }, data: { plan } });
const BETA = [{ property: "groups", op: "is" as const, value: "beta" }];

test("a private portal, groups, readers by email and content for groups need Business", async () => {
  await onPlan("PRO");
  const refused = { status: 402, code: "plan_required", message: "A private portal and reader groups need the Business plan. See Settings → Billing." };
  await expect(call(updatePortal, as(), { access: "private" })).rejects.toMatchObject(refused);
  await expect(call(createGroup, as(), { name: "Beta", conditions: BETA })).rejects.toMatchObject(refused);
  await expect(call(addPortalReaders, as(), { emails: [`e2e-${randomUUID()}@example.com`] })).rejects.toMatchObject(refused);
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { portalAccess: true } })).toEqual({ portalAccess: "PUBLIC" });
  expect(await prisma.readerGroup.count({ where: { projectId: project.id } })).toBe(0);
  expect(await prisma.portalReader.count({ where: { projectId: project.id } })).toBe(0);

  await onPlan("BUSINESS");
  await call(createGroup, as(), { name: "Beta", conditions: BETA });
  await onPlan("PRO");
  await expect(call(updateGroup, as(), { group: "beta", name: "Beta testers" })).rejects.toMatchObject(refused);
  await expect(call(createArticle, as(), { title: "Roadmap", body: "Soon", access: "groups", groups: ["beta"] })).rejects.toMatchObject(refused);
  // Taking things back to public always works.
  await call(updatePortal, as(), { access: "public" });
  await call(deleteGroup, as(), { group: "beta" });
  expect(await prisma.readerGroup.count({ where: { projectId: project.id } })).toBe(0);
});

test("on a lower plan, a private portal stays private and is the team's only; its readers are back with the plan", async () => {
  await onPlan("BUSINESS");
  await call(updatePortal, as(), { access: "private" });
  const reader = await signUp("Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await call(addPortalReaders, as(), { emails: [reader.email], notify: false });
  const ssoUser = await upsertProjectUser(project.id, `ext-${randomUUID()}`, { name: "From the app", email: `e2e-${randomUUID()}@example.com` });
  expect([await canReadPortal({ id: project.id }, reader.id), await canReadPortal({ id: project.id }, ssoUser)]).toEqual([true, true]);

  await onPlan("FREE");
  expect([await canReadPortal({ id: project.id }, reader.id), await canReadPortal({ id: project.id }, ssoUser)]).toEqual([false, false]);
  expect(await canReadPortal({ id: project.id }, owner.id)).toBe(true);
  expect(await canReadPortal({ id: project.id }, null)).toBe(false);
  expect(await prisma.portalReader.count({ where: { projectId: project.id } })).toBe(1);

  await onPlan("BUSINESS");
  expect(await canReadPortal({ id: project.id }, reader.id)).toBe(true);
});

test("on a lower plan, nobody past the team is in a group, so content for groups is the team's only", async () => {
  await onPlan("BUSINESS");
  await call(createGroup, as(), { name: "Beta", conditions: BETA });
  const ssoUser = await upsertProjectUser(project.id, `ext-${randomUUID()}`, { name: "Beta tester", email: `e2e-${randomUUID()}@example.com`, properties: { groups: ["beta"] } });
  expect(await readerOf(project.id, ssoUser)).toEqual({ signedIn: true, groups: ["beta"] });
  await onPlan("PRO");
  expect(await readerOf(project.id, ssoUser)).toEqual({ signedIn: true, groups: [] });
  expect(await readerOf(project.id, owner.id)).toBeNull();
});

test("self-hosted (no plans), every project has them", async () => {
  vi.stubEnv("PLANS", "");
  await call(updatePortal, as(), { access: "private" });
  await call(createGroup, as(), { name: "Beta", conditions: BETA });
  expect(await prisma.readerGroup.count({ where: { projectId: project.id } })).toBe(1);
});
