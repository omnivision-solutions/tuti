import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prisma } from "@tuti/db";
import { creditBalance, grantPlanLicenseCredits } from "@tuti/jobs";
import { billingFile, creditsOn } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { addMember, createProject, signUp, type TestUser } from "@/test/helpers";

/** The operator's script for licenses Tuti hands out itself (scripts/plan-license.mjs). */

const SCRIPT = fileURLToPath(new URL("../../../../scripts/plan-license.mjs", import.meta.url));

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs the script; its output, and whether it succeeded. */
async function run(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)("node", [SCRIPT, ...args], { env: process.env });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr).trim() };
  }
}
const planOf = async () => (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, trialEndsAt: true } })).plan;

test("issue on a project replaces its hand-set plan and gives the plan's credits monthly; revoke takes both back", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });

  const issued = await run("issue", owner.email.toUpperCase(), "pro", project.slug, "our", "own");
  expect(issued.ok).toBe(true);
  const license = await prisma.planLicense.findFirstOrThrow({ where: { source: "tuti", projectId: project.id } });
  expect(license).toMatchObject({ plan: "pro", userId: owner.id, metadata: { note: "our own", replacedPlan: "business" } });
  expect(issued.out).toContain("it replaced the plan business");
  expect(license.claimedAt).not.toBeNull();
  expect(license.assignedAt).not.toBeNull();
  expect(issued.out).toContain(license.externalKey);
  expect(await planOf()).toBe("pro");

  // The hourly job gives its month of credits.
  expect(await grantPlanLicenseCredits()).toEqual({ granted: 1 });
  expect((await creditBalance(project.id)).balance).toBeGreaterThanOrEqual(1000);

  // One license per project.
  expect(await run("issue", owner.email, "pro", project.slug)).toEqual({ ok: false, out: `issue: ${project.slug} has a license already` });

  const before = (await creditBalance(project.id)).balance;
  expect(await run("revoke", license.externalKey)).toEqual({ ok: true, out: `revoke: ${license.externalKey}` });
  expect(await planOf()).toBeNull();
  expect((await creditBalance(project.id)).balance).toBe(before - 1000);
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ revokedAt: expect.any(Date), projectId: project.id });
  expect(await grantPlanLicenseCredits()).toEqual({ granted: 0 });
});

test("issue without a project leaves it on the account; unknown plans, accounts and paying projects are refused", async () => {
  expect((await run("issue", owner.email, "pro")).ok).toBe(true);
  expect(await prisma.planLicense.findFirstOrThrow({ where: { source: "tuti", userId: owner.id } })).toMatchObject({ projectId: null, assignedAt: null });

  expect(await run("issue", owner.email, "nope")).toMatchObject({ ok: false, out: expect.stringContaining("no plan nope") });
  expect(await run("issue", "e2e-nobody@example.com", "pro")).toEqual({ ok: false, out: "issue: no account e2e-nobody@example.com" });
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro", planStatus: "active" } });
  expect(await run("issue", owner.email, "pro", project.slug)).toMatchObject({ ok: false, out: expect.stringContaining("pays for a plan") });
  // Only onto a project the account owns or administers: not another team's, nor one it's a plain member of.
  const other = await createProject(await signUp("Other"));
  expect(await run("issue", owner.email, "pro", other.slug)).toEqual({ ok: false, out: `issue: ${owner.email} isn't an owner or admin of ${other.slug}` });
  const member = await addMember(other.id, "MEMBER");
  expect(await run("issue", member.email, "pro", other.slug)).toEqual({ ok: false, out: `issue: ${member.email} isn't an owner or admin of ${other.slug}` });
  const admin = await addMember(other.id, "ADMIN");
  expect((await run("issue", admin.email, "pro", other.slug)).ok).toBe(true);
  // Never without the billing file to check the plan against.
  vi.stubEnv("BILLING_CONFIG", "");
  expect(await run("issue", owner.email, "pro")).toMatchObject({ ok: false, out: expect.stringContaining("set BILLING_CONFIG") });
  expect(await prisma.planLicense.count({ where: { source: "tuti", userId: owner.id } })).toBe(1);
});

test("revoke refuses while its project has the badge add-on, and takes back a license that was unassigned", async () => {
  await run("issue", owner.email, "pro", project.slug);
  const license = await prisma.planLicense.findFirstOrThrow({ where: { source: "tuti", projectId: project.id } });
  await prisma.project.update({ where: { id: project.id }, data: { badgeAddOn: true } });
  expect(await run("revoke", license.externalKey)).toMatchObject({ ok: false, out: expect.stringContaining("Powered by tuti") });
  expect(await planOf()).toBe("pro");

  await prisma.project.update({ where: { id: project.id }, data: { badgeAddOn: false, plan: null } });
  await prisma.planLicense.update({ where: { id: license.id }, data: { projectId: null, assignedAt: null } });
  expect((await run("revoke", license.externalKey)).ok).toBe(true);
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ revokedAt: expect.any(Date), projectId: null });
  // Again: nothing more, so a plan set on the project since stays.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  expect(await run("revoke", license.externalKey)).toEqual({ ok: false, out: `revoke: ${license.externalKey} was revoked already` });
  expect(await planOf()).toBe("business");
  expect(await run("revoke", "tuti-nope")).toEqual({ ok: false, out: "revoke: no license tuti-nope" });
  expect(await run("issue", owner.email, "pro", "no-such-project")).toEqual({ ok: false, out: "issue: no project no-such-project" });
});
