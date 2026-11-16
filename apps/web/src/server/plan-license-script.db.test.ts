import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prisma } from "@tuti/db";
import { creditBalance, grantPlanLicenseCredits } from "@tuti/jobs";
import { billingFile } from "@tuti/testkit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

/** The operator's script for licenses Tuti hands out itself (scripts/plan-license.mjs). */

const SCRIPT = fileURLToPath(new URL("../../../../scripts/plan-license.mjs", import.meta.url));

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("AI_CREDITS", "on");
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
  expect(license).toMatchObject({ plan: "pro", userId: owner.id, metadata: { note: "our own" } });
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
  expect(await prisma.planLicense.count({ where: { source: "tuti", userId: owner.id } })).toBe(1);
});
