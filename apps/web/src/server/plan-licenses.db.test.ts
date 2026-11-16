import { prisma } from "@tuti/db";
import { creditBalance, grantLicenseCredits, grantPlanLicenseCredits } from "@tuti/jobs";
import { billingFile, type FakeStripeEvent, startStripeFake, type StripeFake, withAppsumoPlans } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { getPlan, subscribePlan } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { assignPlanLicense, unassignPlanLicense } from "./plan-licenses";

/** Plan licenses (docs/plan.md, Plan licenses): an account's licenses, each giving its plan to the one project it's assigned to. */

let stripe: StripeFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries({
    ...stripe.env,
    BILLING_CONFIG: billingFile((config) => {
      withAppsumoPlans(config);
      config.trial = { plan: "pro", days: 7 };
    }),
    AI_CREDITS: "on",
    APP_URL: "https://app.tuti.example",
  })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  actAs(owner);
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const license = (userId: string | null = owner.id, plan = "appsumo-2") =>
  prisma.planLicense.create({ data: { source: "appsumo", externalKey: crypto.randomUUID(), plan, userId } });
const planOf = async (projectId = project.id) => (await call(getPlan, { actor: { kind: "user", userId: owner.id }, projectId }, {})).plan;
const grants = (projectId = project.id) =>
  prisma.aiCreditGrant.findMany({ where: { projectId, source: "PLAN" }, orderBy: { createdAt: "asc" }, select: { credits: true, expiresAt: true, note: true } });
const deliver = async (...events: FakeStripeEvent[]) => {
  for (const { body, headers } of events) {
    expect((await webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }
};

test("assigned, the project is on the license's plan with its month of credits; unassigned, back on its own", async () => {
  const held = await license();
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await planOf()).toBe("appsumo-2");
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ projectId: project.id, assignedAt: expect.any(Date) });
  const [grant] = await grants();
  expect(grant).toMatchObject({ note: "AppSumo Tier 2 license" });
  expect(grant!.credits.toNumber()).toBe(1000);
  // A month: the same day next month.
  expect(grant!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(27 * 86_400_000);
  expect(grant!.expiresAt!.getTime() - Date.now()).toBeLessThan(32 * 86_400_000);
  // Assigning it again changes nothing, nor gives credits twice.
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await grants()).toHaveLength(1);

  expect(await unassignPlanLicense(held.id)).toEqual({});
  expect(await planOf()).toBe("free");
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ projectId: null, assignedAt: null });
});

test("a license replaces a running trial's plan, and the trial is back once it's unassigned", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { trialEndsAt: new Date(Date.now() + 86_400_000) } });
  expect(await planOf()).toBe("pro");
  const held = await license(owner.id, "appsumo-1");
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await planOf()).toBe("appsumo-1");
  expect(await unassignPlanLicense(held.id)).toEqual({});
  expect(await planOf()).toBe("pro");
});

test("only its holder assigns it, to a project they own or administer; its holder or the project's owners and admins unassign it", async () => {
  const someone = await signUp("Someone");
  const theirs = await license(someone.id);
  expect(await assignPlanLicense(project.slug, theirs.id)).toEqual({ error: "That license isn't on your account" });
  // An unclaimed one isn't anyone's.
  expect(await assignPlanLicense(project.slug, (await license(null)).id)).toEqual({ error: "That license isn't on your account" });
  // A member holding one can't put it on the project.
  const member = await addMember(project.id, "MEMBER");
  actAs(member);
  expect(await assignPlanLicense(project.slug, (await license(member.id)).id)).toEqual({ error: "Only project owners and admins can change the plan" });
  // An admin can; a member can't take it off, its holder can, and so can the project's owner.
  const admin = await addMember(project.id, "ADMIN");
  actAs(admin);
  const admins = await license(admin.id);
  expect(await assignPlanLicense(project.slug, admins.id)).toEqual({});
  actAs(member);
  expect(await unassignPlanLicense(admins.id)).toEqual({ error: "That license isn't on your account" });
  expect(await planOf()).toBe("appsumo-2");
  actAs(admin);
  expect(await unassignPlanLicense(admins.id)).toEqual({});
  expect(await assignPlanLicense(project.slug, admins.id)).toEqual({});
  // Its holder gone from the team, the owner takes it off, and the project can buy a plan.
  await prisma.teamMember.deleteMany({ where: { projectId: project.id, userId: admin.id } });
  actAs(owner);
  expect(await unassignPlanLicense(admins.id)).toEqual({});
  expect(await planOf()).toBe("free");
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: admins.id } })).toMatchObject({ userId: admin.id, projectId: null });
});

test("a license is on one project at a time, a project has one, and a revoked one goes nowhere", async () => {
  const held = await license();
  const other = await createProject(owner);
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await assignPlanLicense(other.slug, held.id)).toEqual({ error: "This license is on another project. Unassign it there first." });
  expect(await assignPlanLicense(project.slug, (await license()).id)).toEqual({ error: "This project has a license already. Unassign it first." });
  expect(await planOf(other.id)).toBe("free");

  // Moved, the month's credits aren't given again: the next month's come on time, to the project it's on then.
  expect(await unassignPlanLicense(held.id)).toEqual({});
  expect(await assignPlanLicense(other.slug, held.id)).toEqual({});
  expect(await planOf(other.id)).toBe("appsumo-2");
  expect(await grants(other.id)).toEqual([]);

  const revoked = await prisma.planLicense.create({ data: { source: "appsumo", externalKey: crypto.randomUUID(), plan: "appsumo-1", userId: owner.id, revokedAt: new Date() } });
  expect(await assignPlanLicense(project.slug, revoked.id)).toEqual({ error: "This license was revoked by where it came from, so it gives no plan" });
  expect(await planOf()).toBe("free");
});

test("a project paying through Stripe isn't given one until its plan ends, and one with a license can't buy a plan", async () => {
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  const events = stripe.pay(stripe.sessions.at(-1)!.id);
  const subscription = stripe.sessions.at(-1)!.subscription!;
  await deliver(...events);
  const held = await license();
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({
    error: "This project pays for a plan. Cancel it from Settings → Billing → Manage plan, and assign the license once it ends.",
  });
  // Cancelled, it holds until the end of its period: still refused.
  await deliver(stripe.update(subscription, { status: "active", cancelAtPeriodEnd: true }));
  expect((await assignPlanLicense(project.slug, held.id)).error).toMatch(/^This project pays for a plan/);
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await planOf()).toBe("appsumo-2");

  // The old subscription said again (Stripe's late or repeated events) leaves the license's plan be.
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await planOf()).toBe("appsumo-2");
  await expect(call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" })).rejects.toMatchObject({
    status: 409,
    code: "has_license",
  });
});

test("a subscription that holds no plan but can still be paid (unpaid) keeps a license off the project", async () => {
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  const events = stripe.pay(stripe.sessions.at(-1)!.id);
  const subscription = stripe.sessions.at(-1)!.subscription!;
  await deliver(...events);
  await deliver(stripe.update(subscription, { status: "unpaid" }));
  const held = await license();
  expect((await assignPlanLicense(project.slug, held.id)).error).toMatch(/^This project has a Stripe subscription that can still be paid/);
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  expect(await planOf()).toBe("appsumo-2");
});

test("unassigning from a project's Billing takes the license off that project only", async () => {
  const held = await license();
  const other = await createProject(owner);
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  // Moved since (another tab), then Billing's old page says unassign: refused, still on the other project.
  expect(await unassignPlanLicense(held.id)).toEqual({});
  expect(await assignPlanLicense(other.slug, held.id)).toEqual({});
  expect(await unassignPlanLicense(held.id, project.slug)).toEqual({ error: "This license isn't on this project any more. Reload the page." });
  expect(await planOf(other.id)).toBe("appsumo-2");
  expect(await unassignPlanLicense(held.id, other.slug)).toEqual({});
  expect(await planOf(other.id)).toBe("free");
});

test("an admin who doesn't hold the license, unassigning from Billing after it moved, is told to reload", async () => {
  const held = await license();
  const admin = await addMember(project.id, "ADMIN");
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  // The holder moves it to a project the admin isn't on.
  expect(await unassignPlanLicense(held.id)).toEqual({});
  const mine = await createProject(owner);
  expect(await assignPlanLicense(mine.slug, held.id)).toEqual({});
  actAs(admin);
  expect(await unassignPlanLicense(held.id, project.slug)).toEqual({ error: "This license isn't on this project any more. Reload the page." });
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id }, select: { projectId: true } })).toEqual({ projectId: mine.id });
});

test("when Stripe can't say whether the project's subscription has ended, the license isn't assigned", async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_wrong");
  const held = await license();
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({ error: "We couldn't check this project's plan with Stripe. Try again in a minute." });
  expect(await planOf()).toBe("free");
});

test("a Checkout still being paid (a bank debit, incomplete) keeps a license off the project", async () => {
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  stripe.pay(stripe.sessions.at(-1)!.id);
  const subscription = stripe.sessions.at(-1)!.subscription!;
  await deliver(stripe.update(subscription, { status: "incomplete" }));
  const held = await license();
  expect((await assignPlanLicense(project.slug, held.id)).error).toMatch(/^This project has a Stripe subscription that can still be paid/);
});

test("an older subscription still unpaid keeps a license off, whatever happened to a later one", async () => {
  // A goes unpaid; the project buys again (B), whose bank debit fails and expires. A can still be paid.
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  await deliver(...stripe.pay(stripe.sessions.at(-1)!.id));
  const first = stripe.sessions.at(-1)!.subscription!;
  await deliver(stripe.update(first, { status: "unpaid" }));
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  stripe.pay(stripe.sessions.at(-1)!.id);
  await deliver(stripe.update(stripe.sessions.at(-1)!.subscription!, { status: "incomplete_expired" }));
  const held = await license();
  expect((await assignPlanLicense(project.slug, held.id)).error).toMatch(/^This project has a Stripe subscription that can still be paid/);
  await deliver(stripe.update(first, { status: "canceled" }));
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
});

test("a subscription paid after its project was given a license doesn't take the project, even with the license revoked", async () => {
  // A Checkout opened before the license was assigned, paid once the license was revoked (it gives no plan).
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" });
  const held = await license();
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  await prisma.planLicense.update({ where: { id: held.id }, data: { revokedAt: new Date() } });
  await prisma.project.update({ where: { id: project.id }, data: { plan: null } });
  await deliver(...stripe.pay(stripe.sessions.at(-1)!.id));
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, planStatus: true, stripeSubscriptionId: true } })).toEqual({
    plan: null,
    planStatus: null,
    stripeSubscriptionId: null,
  });
});

test("a project with a plan set by hand isn't given one", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  expect(await assignPlanLicense(project.slug, (await license()).id)).toEqual({ error: "This project has a plan already. Contact support to change it." });
  expect(await planOf()).toBe("business");
});

test("each month the license is assigned and not revoked, its project gets the month's credits, once", async () => {
  const held = await license();
  expect(await assignPlanLicense(project.slug, held.id)).toEqual({});
  const { creditsThrough } = await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id } });
  // Not before the month is nearly over (the database is this file's: other tests' licenses are due by then).
  await grantPlanLicenseCredits(new Date(creditsThrough!.getTime() - 2 * 3_600_000));
  expect(await grants()).toHaveLength(1);
  // Within its last hour: the next month, following on from it, once however often the job runs.
  const soon = new Date(creditsThrough!.getTime() - 30 * 60_000);
  await grantPlanLicenseCredits(soon);
  await grantPlanLicenseCredits(soon);
  expect(await grants()).toHaveLength(2);
  const [, next] = await grants();
  expect(next!.expiresAt!.getTime()).toBeGreaterThan(creditsThrough!.getTime() + 27 * 86_400_000);
  const { creditsThrough: through } = await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id } });
  expect(next!.expiresAt).toEqual(through);
  expect((await creditBalance(project.id)).balance).toBe(2000);

  // Unassigned, none; assigned again weeks after its month ended, a month from then, not from the old one.
  expect(await unassignPlanLicense(held.id)).toEqual({});
  await grantPlanLicenseCredits(new Date(through!.getTime() + 60_000));
  expect(await grants()).toHaveLength(2);
  await prisma.planLicense.update({ where: { id: held.id }, data: { projectId: project.id, creditsThrough: new Date(Date.now() - 20 * 86_400_000) } });
  await grantPlanLicenseCredits();
  const [, , restarted] = await grants();
  expect(restarted!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(27 * 86_400_000);
  // Revoked, none.
  await prisma.planLicense.update({ where: { id: held.id }, data: { revokedAt: new Date(), creditsThrough: new Date() } });
  await grantPlanLicenseCredits();
  expect(await grants()).toHaveLength(3);
});

test("a month of credits from January 31 lasts until February's last day", async () => {
  const held = await prisma.planLicense.create({ data: { source: "appsumo", externalKey: crypto.randomUUID(), plan: "appsumo-2", userId: owner.id, projectId: project.id } });
  await grantLicenseCredits(held.id, new Date("2027-01-31T12:00:00Z"));
  expect((await prisma.planLicense.findUniqueOrThrow({ where: { id: held.id } })).creditsThrough).toEqual(new Date("2027-02-28T12:00:00Z"));
});
