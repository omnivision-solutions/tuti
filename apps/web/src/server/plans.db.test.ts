import { prisma } from "@tuti/db";
import { creditBalance } from "@tuti/jobs";
import { FAKE_STRIPE_PRICES, startStripeFake, type FakeStripeEvent, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
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
  for (const [name, value] of Object.entries({ ...stripe.env, PLANS: "on", AI_CREDITS: "on", APP_URL: "https://app.tuti.example" })) {
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
async function subscribe(which: "pro" | "business" = "pro", interval: "month" | "year" = "month") {
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
  });
  const grants = await planGrants();
  expect(grants).toHaveLength(1);
  expect(grants[0]!.credits.toNumber()).toBe(1000);
  expect(grants[0]!.expiresAt).toEqual(new Date(sub.items.data[0]!.current_period_end * 1000));
  // Credits a month are the operator's to set.
  vi.stubEnv("AI_CREDITS_PRO", "250");
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
  expect(await plan()).toEqual({ enabled: true, plan: "free", interval: null, status: null, periodEnd: null, endsAt: null });
  // The customer stays: a later plan is billed to it.
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  expect(stripe.sessions.at(-1)).toMatchObject({ customer: stripe.subscriptions.get(subscription)!.customer, customer_email: null });
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

test("a project has one plan: while one is live, another can't be started, and a second subscription changes nothing", async () => {
  const first = await subscribe("pro");
  // A second Checkout opened before the first was paid.
  await call(subscribePlan, as(), { plan: "business", interval: "month" });
  const second = stripe.sessions.at(-1)!;
  await deliver(...first.events);
  await expect(call(subscribePlan, as(), { plan: "business", interval: "month" })).rejects.toMatchObject({ status: 409, code: "has_plan" });
  await deliver(...stripe.pay(second.id));
  expect(await plan()).toMatchObject({ plan: "pro" });
  // Its paid invoice gives no credits either: only the first's month.
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000]);
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { stripeSubscriptionId: true } })).toEqual({
    stripeSubscriptionId: first.subscription,
  });
  // Its own end doesn't end the plan.
  await deliver(stripe.update(second.subscription!, { status: "canceled" }));
  expect(await plan()).toMatchObject({ plan: "pro" });
});

test("a second subscription's paid invoice reported after both ended still gives nothing; the first's does", async () => {
  const first = await subscribe("pro");
  await call(subscribePlan, as(), { plan: "business", interval: "month" });
  const second = stripe.sessions.at(-1)!;
  await deliver(...first.events);
  const [completed, created, paid] = stripe.pay(second.id);
  await deliver(completed!, created!);
  // The first renews (paid), then both end, and Stripe reports those invoices only then.
  const renewed = stripe.renew(first.subscription)[1]!;
  await deliver(stripe.update(second.subscription!, { status: "canceled" }), stripe.update(first.subscription, { status: "canceled" }));
  await deliver(paid!);
  expect(await plan()).toMatchObject({ plan: "free" });
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000]);
  await deliver(renewed);
  expect((await planGrants()).map((grant) => grant.credits.toNumber())).toEqual([1000, 1000]);
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
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", `price_new_pro,${stripe.env.STRIPE_PRICE_PRO_MONTHLY}`);
  await deliver(stripe.update(subscription, {}));
  expect(await plan()).toMatchObject({ plan: "pro" });
  // New plans are sold at the new price.
  await deliver(stripe.update(subscription, { status: "canceled" }));
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  expect(stripe.sessions.at(-1)!.price).toBe("price_new_pro");
});

test("not sold: plans off, Stripe not set up, or a plan without its price; plan.get says plans are off", async () => {
  vi.stubEnv("STRIPE_PRICE_PRO_YEARLY", "");
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "year" })).rejects.toMatchObject({ status: 503, code: "plans_unavailable" });
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", stripe.env.STRIPE_WEBHOOK_SECRET!);
  vi.stubEnv("PLANS", "");
  await expect(call(subscribePlan, as(), { plan: "pro", interval: "month" })).rejects.toMatchObject({ status: 503 });
  expect(await plan()).toMatchObject({ enabled: false, plan: "free" });
  expect(stripe.sessions.filter((session) => session.client_reference_id === project.id)).toEqual([]);
});

test("Manage plan opens Stripe's customer portal for the project's customer, even once plans stop being sold", async () => {
  await expect(call(managePlan, as(), {})).rejects.toMatchObject({ status: 409, code: "no_plan" });
  const { subscription, events } = await subscribe("pro");
  await deliver(...events);
  vi.stubEnv("PLANS", "");
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
