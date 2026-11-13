import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { creditBalance } from "@tuti/jobs";
import { billingFile, FAKE_STRIPE_PRICES, type FakeStripeEvent, startStripeFake, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { portalUrl } from "@/lib/hosts";
import { getPlan, managePlan, subscribePlan } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Plans (docs/plan.md, Plans): Stripe Checkout starts one, Stripe's webhook keeps the project's plan in step, and each paid period gives its AI credits once. */

let stripe: StripeFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...stripe.env, BILLING_CONFIG: billingFile(), AI_CREDITS: "on", APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const deliver = async (...events: FakeStripeEvent[]) => {
  for (const { body, headers } of events) {
    expect((await webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }
};
const plan = () => call(getPlan, as(), {});
const planGrants = () =>
  prisma.aiCreditGrant.findMany({ where: { projectId: project.id, source: "PLAN" }, orderBy: { createdAt: "asc" }, select: { credits: true, expiresAt: true, stripeInvoiceId: true } });

/** Starts `which` for the project and pays for it; returns its subscription's id and the events Stripe sends. */
async function subscribe(which = "pro", interval: "month" | "year" = "month") {
  await call(subscribePlan, as(), { plan: which, interval });
  const events = stripe.pay(stripe.sessions.at(-1)!.id);
  return { subscription: stripe.sessions.at(-1)!.subscription!, events };
}

test("a plan opens Stripe Checkout for its price, the project's id on the subscription", async () => {
  const { url } = await call(subscribePlan, as(), { plan: "business", interval: "year" });
  const session = stripe.sessions.at(-1)!;
  expect(url).toBe(session.url);
  expect(session).toMatchObject({
    mode: "subscription",
    price: FAKE_STRIPE_PRICES.STRIPE_PRICE_BUSINESS_YEARLY.id,
    subscription_metadata: { projectId: project.id },
    client_reference_id: project.id,
    customer_email: owner.email,
    success_url: `https://app.tuti.example/app/${project.slug}/settings/billing?subscribed=1`,
    cancel_url: `https://app.tuti.example/app/${project.slug}/settings/billing`,
  });
  // Nothing changes until Stripe says it's paid.
  expect(await plan()).toMatchObject({ enabled: true, plan: "free", interval: null });
});

test("paid, the project is on the plan, with the month's credits once, however often Stripe says so", async () => {
  const { subscription, events } = await subscribe("pro");
  await deliver(...events, ...events);
  const sub = stripe.subscriptions.get(subscription)!;
  expect(await plan()).toEqual({
    enabled: true,
    plan: "pro",
    interval: "month",
    status: "active",
    periodEnd: new Date(sub.items.data[0]!.current_period_end * 1000),
    endsAt: null,
    badge: false,
  });
  const grants = await planGrants();
  expect(grants).toHaveLength(1);
  expect(grants[0]!.credits.toNumber()).toBe(1000);
  expect(grants[0]!.expiresAt).toEqual(new Date(sub.items.data[0]!.current_period_end * 1000));
  // Credits a month are the operator's to set.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.monthlyCredits = 250; }));
  await deliver(...stripe.renew(subscription));
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000, 250]);
  expect((await creditBalance(project.id)).balance).toBe(1250);
});

test("a year's plan gives twelve months of credits, lasting the year", async () => {
  const { subscription, events } = await subscribe("business", "year");
  await deliver(...events);
  const [grant] = await planGrants();
  expect(grant!.credits.toNumber()).toBe(60_000);
  expect(grant!.expiresAt).toEqual(new Date(stripe.subscriptions.get(subscription)!.items.data[0]!.current_period_end * 1000));
  expect(grant!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(364 * 86_400_000);
});

test("changes in the customer portal follow: another plan, a failed payment, cancelling, and the end", async () => {
  const { subscription, events } = await subscribe("pro");
  await deliver(...events);
  await deliver(stripe.update(subscription, { price: FAKE_STRIPE_PRICES.STRIPE_PRICE_BUSINESS_MONTHLY.id }));
  expect(await plan()).toMatchObject({ plan: "business", status: "active" });
  // An upgrade's proration isn't a period: no credits until the next one.
  expect(await planGrants()).toHaveLength(1);
  // While Stripe retries a failed payment, the plan holds.
  await deliver(stripe.update(subscription, { status: "past_due" }));
  expect(await plan()).toMatchObject({ plan: "business", status: "past_due" });
  await deliver(stripe.update(subscription, { status: "active", cancelAtPeriodEnd: true }));
  const end = new Date(stripe.subscriptions.get(subscription)!.items.data[0]!.current_period_end * 1000);
  expect(await plan()).toMatchObject({ plan: "business", endsAt: end });
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await plan()).toEqual({ enabled: true, plan: "free", interval: null, status: null, periodEnd: null, endsAt: null, badge: false });
  // The customer stays: a later plan is billed to it.
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  expect(stripe.sessions.at(-1)).toMatchObject({ customer: stripe.subscriptions.get(subscription)!.customer, customer_email: null });
});

test("each project is its own Stripe customer, and its subscription says which project it is (Stripe's portal shows it)", async () => {
  const { subscription, events } = await subscribe("business");
  await deliver(...events);
  const { name, slug, stripeCustomerId } = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  expect(stripe.subscriptions.get(subscription)!.description).toBe(`Tuti Business for ${name} (${new URL(portalUrl(slug)).host})`);
  // Another project of the same owner: a customer of its own, so Manage plan there shows only its plan.
  const other = await createProject(owner);
  await call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: other.id }, { plan: "pro", interval: "month" });
  await deliver(...stripe.pay(stripe.sessions.at(-1)!.id));
  const second = await prisma.project.findUniqueOrThrow({ where: { id: other.id } });
  expect(second.stripeCustomerId).toEqual(expect.any(String));
  expect(second.stripeCustomerId).not.toBe(stripeCustomerId);
  expect(stripe.subscriptions.get(second.stripeSubscriptionId!)!.description).toBe(`Tuti Pro for ${second.name} (${new URL(portalUrl(second.slug)).host})`);
});

test("events late or out of order can't bring back an old state: the subscription is read from Stripe", async () => {
  const { subscription, events } = await subscribe("pro");
  const created = events[1]!;
  await deliver(...events);
  await deliver(stripe.update(subscription, { status: "canceled" }));
  // "created" again, after the end.
  await deliver(created);
  expect(await plan()).toMatchObject({ plan: "free" });
});

test("a paid invoice Stripe reports only after the subscription ended still gives its month's credits", async () => {
  const { subscription, events } = await subscribe("pro");
  const [completed, created, paid] = events;
  await deliver(completed!, created!);
  await deliver(stripe.update(subscription, { status: "canceled" }));
  await deliver(paid!);
  expect(await plan()).toMatchObject({ plan: "free" });
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000]);
});

test("a project has one plan: while one is live, another can't be started, and a second subscription doesn't take it", async () => {
  const first = await subscribe("pro");
  // A second Checkout opened before the first was paid.
  await call(subscribePlan, as(), { plan: "business", interval: "month" });
  const second = stripe.sessions.at(-1)!;
  await deliver(...first.events);
  await expect(call(subscribePlan, as(), { plan: "business", interval: "month" })).rejects.toMatchObject({ status: 409, code: "has_plan" });
  await deliver(...stripe.pay(second.id));
  expect(await plan()).toMatchObject({ plan: "pro" });
  // Paid for, its month's credits come (refunding it, as the operator is asked to, takes them back).
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000, 5000]);
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { stripeSubscriptionId: true } })).toEqual({
    stripeSubscriptionId: first.subscription,
  });
  // Its own end doesn't end the plan.
  await deliver(stripe.update(second.subscription!, { status: "canceled" }));
  expect(await plan()).toMatchObject({ plan: "pro" });
});

test("a paid subscription that ended before Stripe said anything about it still gives its month's credits", async () => {
  const { subscription, events } = await subscribe("pro");
  stripe.update(subscription, { status: "canceled" });
  await deliver(...events);
  expect(await plan()).toMatchObject({ plan: "free" });
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000]);
});

test("a subscription paid after the first stopped holding the plan (unpaid, not ended) gets its credits", async () => {
  const first = await subscribe("pro");
  await deliver(...first.events);
  await deliver(stripe.update(first.subscription, { status: "unpaid" }));
  expect(await plan()).toMatchObject({ plan: "free" });
  const next = await subscribe("business");
  stripe.update(next.subscription, { status: "canceled" });
  await deliver(...next.events);
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000, 5000]);
});

test("a renewal reported after its subscription ended and another took the plan still gives its credits", async () => {
  const first = await subscribe("pro");
  await deliver(...first.events);
  const renewed = stripe.renew(first.subscription)[1]!;
  await deliver(stripe.update(first.subscription, { status: "canceled" }));
  const next = await subscribe("business");
  await deliver(...next.events);
  expect(await plan()).toMatchObject({ plan: "business" });
  await deliver(renewed);
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000, 5000, 1000]);
});

test("a plan's price replaced in Stripe: those on the older price keep their plan", async () => {
  const { subscription, events } = await subscribe("pro");
  await deliver(...events);
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.prices.month!.stripe.unshift("price_new_pro"); }));
  await deliver(stripe.update(subscription, {}));
  expect(await plan()).toMatchObject({ plan: "pro" });
  // New plans are sold at the new price.
  await deliver(stripe.update(subscription, { status: "canceled" }));
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  expect(stripe.sessions.at(-1)!.price).toBe("price_new_pro");
});

test("a price no longer sold (sold: false) keeps those who pay it on their plan, and isn't sold again", async () => {
  const { subscription, events } = await subscribe("pro");
  await deliver(...events);
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.prices.month!.sold = false; }));
  await deliver(stripe.update(subscription, {}));
  expect(await plan()).toMatchObject({ plan: "pro" });
  await deliver(stripe.update(subscription, { status: "canceled" }));
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
});

test("not sold: plans off, Stripe not set up, or a plan without its price; plan.get says plans are off", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { delete pro.prices.year; }));
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "year" })).rejects.toMatchObject({ status: 503, code: "plans_unavailable" });
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripe.env.STRIPE_WEBHOOK_SECRET!);
  vi.stubEnv("BILLING_CONFIG", "");
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
  expect(await plan()).toMatchObject({ enabled: false, plan: "free" });
  expect(stripe.sessions.filter((session) => session.client_reference_id === project.id)).toEqual([]);
});

test("Manage plan opens Stripe's customer portal for the project's customer, even once plans stop being sold", async () => {
  await expect(call(managePlan, as(), {})).rejects.toMatchObject({ status: 409, code: "no_plan" });
  const { subscription, events } = await subscribe("pro");
  await deliver(...events);
  vi.stubEnv("BILLING_CONFIG", "");
  const { url } = await call(managePlan, as(), {});
  expect(stripe.portals.at(-1)).toMatchObject({
    url,
    customer: stripe.subscriptions.get(subscription)!.customer,
    return_url: `https://app.tuti.example/app/${project.slug}/settings/billing`,
  });
});

test("a subscription Tuti didn't start, and invoices that aren't a plan's period, change nothing", async () => {
  const { subscription, events } = await subscribe("pro");
  stripe.subscriptions.get(subscription)!.metadata = {};
  await deliver(...events);
  expect(await plan()).toMatchObject({ plan: "free" });
  expect(await planGrants()).toEqual([]);
});

test("a project deleted meanwhile: Stripe's events are answered, and nothing is given", async () => {
  const { events } = await subscribe("pro");
  await prisma.project.delete({ where: { id: project.id } });
  await deliver(...events);
  expect(await prisma.aiCreditGrant.count({ where: { projectId: project.id } })).toBe(0);
});

test("the migration gives each project its plan's key: Pro and Business theirs, Free none (the default plan)", async () => {
  const projects = await Promise.all((["FREE", "PRO", "BUSINESS"] as const).map(async (planEnum) => (await prisma.project.update({ where: { id: (await createProject(owner)).id }, data: { planEnum } })).id));
  // As before the migration: no key (cleared without writing the enum, which the trigger would follow).
  await prisma.$executeRaw`UPDATE project SET "planKey" = NULL WHERE id = ANY(${projects})`;
  expect((await prisma.project.findMany({ where: { id: { in: projects } }, select: { plan: true } })).map(({ plan }) => plan)).toEqual([null, null, null]);
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261113180000_plan_keys/migration.sql", import.meta.url), "utf8");
  // The column is there already (every migration ran); its fill, again on these rows.
  await prisma.$executeRawUnsafe(sql.slice(sql.indexOf("UPDATE"), sql.indexOf(";", sql.indexOf("UPDATE")) + 1));
  const plans = await prisma.project.findMany({ where: { id: { in: projects } }, select: { id: true, plan: true } });
  expect(projects.map((id) => plans.find((project) => project.id === id)!.plan)).toEqual([null, "pro", "business"]);
});

test("any plan the file sells is bought by its key, and Stripe's webhook stores that key", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { free, pro, business }) => {
    free.key = "lapsed";
    pro.key = "starter";
    business.key = "scale";
    config.defaultPlan = "lapsed";
  }));
  const { subscription, events } = await subscribe("scale");
  await deliver(...events);
  expect(await plan()).toMatchObject({ plan: "scale" });
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await plan()).toMatchObject({ plan: "lapsed" });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } })).plan).toBeNull();
  await expect(call(subscribePlan, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
});

test("while a deploy runs both releases, the previous one's plan writes follow into the key, and this one keeps the enum in step", async () => {
  const id = project.id;
  const key = async () => (await prisma.project.findUniqueOrThrow({ where: { id }, select: { plan: true, planEnum: true } }));
  // The previous release's webhook: the enum only (a paid plan with its status, then ended with its status cleared).
  await prisma.$executeRaw`UPDATE project SET plan = 'PRO', "planStatus" = 'active' WHERE id = ${id}`;
  expect(await key()).toEqual({ plan: "pro", planEnum: "PRO" });
  await prisma.$executeRaw`UPDATE project SET plan = 'FREE', "planStatus" = NULL WHERE id = ${id}`;
  expect(await key()).toEqual({ plan: null, planEnum: "FREE" });
  // A key changed on its own (a plan renamed in the file), then this release's write of Free beside it: the key stays.
  await prisma.$executeRaw`UPDATE project SET plan = 'PRO', "planStatus" = 'active' WHERE id = ${id}`;
  await prisma.$executeRaw`UPDATE project SET "planKey" = 'starter' WHERE id = ${id}`;
  await prisma.project.update({ where: { id }, data: { plan: "starter", planEnum: "FREE" } });
  expect(await key()).toEqual({ plan: "starter", planEnum: "FREE" });
  await prisma.project.update({ where: { id }, data: { planStatus: null } });
  // This release writes both: a key the enum has no name for stays.
  await prisma.project.update({ where: { id }, data: { plan: "scale", planEnum: "FREE" } });
  expect((await key()).plan).toBe("scale");
  await prisma.project.update({ where: { id }, data: { plan: null } });
  // Its webhook keeps the enum in step for the previous release's worker.
  const { subscription, events } = await subscribe("business");
  await deliver(...events);
  expect(await key()).toMatchObject({ plan: "business", planEnum: "BUSINESS" });
  // And once it ends: the previous release's worker sees Free too.
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await key()).toEqual({ plan: null, planEnum: "FREE" });
});

test("a project on a plan the file no longer lists is on the default plan: it can buy one, and the webhook gives it", async () => {
  // Set by hand once (a Business no longer sold), with no subscription.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "retired" } });
  // plan.get says so: the default plan's key, not one the file doesn't have.
  expect(await plan()).toMatchObject({ plan: "free" });
  const { events } = await subscribe("pro");
  await deliver(...events);
  expect(await plan()).toMatchObject({ plan: "pro" });
});

test("a project still paying for a plan the file no longer lists can't buy a second one", async () => {
  const { events } = await subscribe("pro");
  await deliver(...events);
  // Pro taken out of the file (it should be kept, sold: false), its subscription still live.
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.plans = config.plans.filter(({ key }) => key !== "pro"); }));
  await expect(call(subscribePlan, as(), { plan: "business", interval: "month" })).rejects.toMatchObject({ status: 409, code: "has_plan" });
});

test("a plan the file sells set by hand (by quote) isn't overwritten by a stray subscription's webhook", async () => {
  // A Checkout opened on the default plan, then the project set to Business by hand, then the old Checkout paid.
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  const session = stripe.sessions.at(-1)!;
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  await deliver(...stripe.pay(session.id));
  expect(await plan()).toMatchObject({ plan: "business" });
});
