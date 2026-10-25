import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { portalUrl } from "@/lib/hosts";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { forgetCustomDomain, portalAddress, requestTarget, siteMount } from "./custom-domains";
import { setDomain } from "./operations/domain";
import { call } from "./operations/run";
import { setSite } from "./operations/site";

/**
 * Where plans are sold (docs/plan.md, Plans): a custom domain is on Pro and Business, a portal under a
 * path of the team's site on Business. On a lower plan, what was set up is kept but not served: the
 * portal is at its Tuti address until the plan is back.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let hostname: string;

beforeEach(async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  owner = await signUp("Owner");
  project = await createProject(owner);
  hostname = `help-${project.slug}.example.com`;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const onPlan = async (plan: "FREE" | "PRO" | "BUSINESS") => {
  await prisma.project.update({ where: { id: project.id }, data: { plan } });
  // What this server remembers about addresses (for 10 seconds) is read again.
  forgetCustomDomain(hostname);
};

test("a custom domain needs Pro, a path of the site Business", async () => {
  await expect(call(setDomain, as(), { hostname })).rejects.toMatchObject({
    status: 402,
    code: "plan_required",
    message: "A custom domain needs the Pro plan. See Settings → Billing.",
  });
  await expect(call(setSite, as(), { url: "https://example.com/portal" })).rejects.toMatchObject({
    status: 402,
    message: "A portal under a path of your site needs the Business plan. See Settings → Billing.",
  });
  await onPlan("PRO");
  expect((await call(setDomain, as(), { hostname })).domain.hostname).toBe(hostname);
  await expect(call(setSite, as(), { url: "https://example.com/portal" })).rejects.toMatchObject({ status: 402 });
  expect(await prisma.siteMount.count({ where: { projectId: project.id } })).toBe(0);
});

test("a live domain on a project that drops to Free isn't served, and links go to the Tuti address, until the plan is back", async () => {
  await onPlan("PRO");
  await prisma.customDomain.create({ data: { projectId: project.id, hostname, verificationToken: "t", verifiedAt: new Date() } });
  expect(await requestTarget(hostname)).toMatchObject({ kind: "portal", slug: project.slug, customDomain: hostname });
  const { protocol, port } = new URL(portalUrl(project.slug));
  expect(await portalAddress(project.slug)).toBe(`${protocol}//${hostname}${port ? `:${port}` : ""}`);

  await onPlan("FREE");
  expect(await requestTarget(hostname)).toMatchObject({ kind: "unknown" });
  expect(await portalAddress(project.slug)).toBe(new URL(portalUrl(project.slug)).origin);
  // Kept, for when the plan is back.
  expect(await prisma.customDomain.count({ where: { projectId: project.id } })).toBe(1);

  await onPlan("PRO");
  expect(await requestTarget(hostname)).toMatchObject({ kind: "portal", slug: project.slug });
});

test("a path of the site on a project that drops to Pro isn't served either", async () => {
  await onPlan("BUSINESS");
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://example.com", path: "/portal", verificationToken: "t", verifiedAt: new Date() } });
  expect(await siteMount(project.slug)).toEqual({ origin: "https://example.com", path: "/portal" });
  expect(await portalAddress(project.slug)).toBe("https://example.com/portal");

  await onPlan("PRO");
  expect(await siteMount(project.slug)).toBeNull();
  expect(await portalAddress(project.slug)).toBe(new URL(portalUrl(project.slug)).origin);
  expect(await prisma.siteMount.count({ where: { projectId: project.id } })).toBe(1);
});

test("self-hosted (no plans), every project has both", async () => {
  vi.stubEnv("PLANS", "");
  expect((await call(setDomain, as(), { hostname })).domain.hostname).toBe(hostname);
  await prisma.customDomain.update({ where: { projectId: project.id }, data: { verifiedAt: new Date() } });
  forgetCustomDomain(hostname);
  expect(await requestTarget(hostname)).toMatchObject({ kind: "portal", slug: project.slug });
});
