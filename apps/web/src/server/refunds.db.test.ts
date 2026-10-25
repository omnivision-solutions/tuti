import { aiFor, aiPaused, creditBalance } from "@tuti/jobs";
import { startStripeFake, type FakeStripeEvent, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { branding } from "@/server/operations/branding";
import { topUpCredits } from "@/server/operations/credits";
import { getPlan, setBadgeAddOn, subscribePlan } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Refunds and disputes take back what was paid for (docs/plan.md, Plans): credits, the plan, the add-on. */

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
const balance = async () => (await creditBalance(project.id)).balance;
/** Spends `credits` on AI answers (100 credits a dollar of model cost), as a feature's meter records them. */
const spend = async (credits: number) =>
  (await aiFor(project.id, "answers")).meter({ kind: "chat", model: "acme/writer", inputTokens: 100, outputTokens: 10, cost: credits / 100 });
const shown = async () => (await branding({ id: project.id }))!.poweredBy;

/** Buys `dollars` of credits (100 a dollar); returns the session's charge. */
async function topUp(dollars: number) {
  await call(topUpCredits, as(), { dollars });
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  return stripe.chargeFor(session.id);
}

async function subscribe() {
  await call(subscribePlan, as(), { plan: "pro", interval: "month" });
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  const subscription = session.subscription!;
  const [invoice] = [...stripe.invoices.values()].filter((each) => each.parent.subscription_details.subscription === subscription);
  return { subscription, charge: stripe.chargeFor(invoice!.id) };
}

test("a top-up refunded takes its credits back: a share at a time, once each, however often Stripe says so", async () => {
  const charge = await topUp(10);
  expect(await balance()).toBe(1000);
  await deliver(stripe.refund(charge.id, 500), stripe.refund(charge.id, 0));
  expect(await balance()).toBe(500);
  await deliver(stripe.refund(charge.id));
  expect(await balance()).toBe(0);
  await deliver(stripe.refund(charge.id));
  expect(await balance()).toBe(0);
});

test("credits already spent when the top-up is refunded become debt: the project's AI pauses until it has more", async () => {
  const charge = await topUp(10);
  await spend(600);
  await deliver(stripe.refund(charge.id));
  expect(await balance()).toBe(-600);
  expect(await aiPaused(project.id)).toBe(true);
});

test("a disputed top-up takes all its credits back", async () => {
  const charge = await topUp(25);
  await deliver(stripe.dispute(charge.id));
  expect(await balance()).toBe(0);
});

test("a plan's period refunded in full ends the plan at once, the add-on with it, and takes its credits back", async () => {
  const { subscription, charge } = await subscribe();
  await call(setBadgeAddOn, as(), { on: true });
  expect(await balance()).toBe(1000);
  await deliver(stripe.refund(charge.id));
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "free", badge: false });
  expect(await shown()).toBe(true);
  expect(await balance()).toBe(0);
});

test("a plan's period refunded in part takes back that share of its credits; the plan stays", async () => {
  const { charge } = await subscribe();
  await deliver(stripe.refund(charge.id, Math.round(charge.amount / 4)));
  expect(await balance()).toBe(750);
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "pro" });
});

test("a disputed plan payment ends the plan", async () => {
  const { subscription, charge } = await subscribe();
  await deliver(stripe.dispute(charge.id));
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "free" });
});

test("the add-on's own charge refunded in full removes it, with nothing more credited; the plan stays", async () => {
  const { subscription } = await subscribe();
  await call(setBadgeAddOn, as(), { on: true });
  const proration = [...stripe.invoices.values()].find(
    (invoice) => invoice.billing_reason === "subscription_update" && invoice.parent.subscription_details.subscription === subscription,
  )!;
  await deliver(stripe.refund(stripe.chargeFor(proration.id).id));
  expect(stripe.subscriptions.get(subscription)!.items.data.map((item) => item.price.id)).toEqual([stripe.env.STRIPE_PRICE_PRO_MONTHLY]);
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "pro", badge: false });
  expect(await shown()).toBe(true);
});
