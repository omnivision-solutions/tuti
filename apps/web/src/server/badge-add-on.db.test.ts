import { prisma } from "@tuti/db";
import { FAKE_STRIPE_PRICES, startStripeFake, type FakeStripeEvent, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { branding, updateBranding } from "@/server/operations/branding";
import { getPlan, setBadgeAddOn, subscribePlan } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Hiding "Powered by tuti" on tuti.so (docs/plan.md, Plans and Licences): a $49 add-on on a paid plan, hiding the badge while both are paid. */

let stripe: StripeFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...stripe.env, PLANS: "on", APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  stripe.declining = false;
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
const badge = (on: boolean) => call(setBadgeAddOn, as(), { on });
/** Whether the portal shows "Powered by tuti". */
const shown = async () => (await branding({ id: project.id }))!.poweredBy;
const items = (subscription: string) => stripe.subscriptions.get(subscription)!.items.data.map((item) => item.price.id);

async function subscribe(interval: "month" | "year" = "month") {
  await call(subscribePlan, as(), { plan: "pro", interval });
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  return session.subscription!;
}

test("on a paid plan, the add-on joins the subscription and hides the badge; once, however often it's asked for", async () => {
  const subscription = await subscribe();
  expect(await shown()).toBe(true);
  expect(await badge(true)).toEqual({ on: true });
  expect(await badge(true)).toEqual({ on: true });
  expect(items(subscription)).toEqual([FAKE_STRIPE_PRICES.STRIPE_PRICE_PRO_MONTHLY.id, FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_MONTHLY.id]);
  expect(await shown()).toBe(false);
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "pro", badge: true });
});

test("a yearly plan gets the yearly add-on (a subscription's prices bill alike)", async () => {
  const subscription = await subscribe("year");
  await badge(true);
  expect(items(subscription)).toEqual([FAKE_STRIPE_PRICES.STRIPE_PRICE_PRO_YEARLY.id, FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_YEARLY.id]);
});

test("refused on the free plan, while a payment is failing, and when the card is declined; nothing changes", async () => {
  await expect(badge(true)).rejects.toMatchObject({ status: 409, code: "free_plan" });
  const subscription = await subscribe();
  await deliver(stripe.update(subscription, { status: "past_due" }));
  await expect(badge(true)).rejects.toMatchObject({ status: 409, code: "payment_failing" });
  await deliver(stripe.update(subscription, { status: "active" }));
  stripe.declining = true;
  await expect(badge(true)).rejects.toMatchObject({ status: 402, code: "payment_failed" });
  expect(items(subscription)).toEqual([FAKE_STRIPE_PRICES.STRIPE_PRICE_PRO_MONTHLY.id]);
  expect(await shown()).toBe(true);
  // And not sold where its price isn't set.
  stripe.declining = false;
  vi.stubEnv("STRIPE_PRICE_BADGE_MONTHLY", "");
  await expect(badge(true)).rejects.toMatchObject({ status: 503 });
});

test("it ends with the plan: the badge is back, and can't be hidden again without it", async () => {
  const subscription = await subscribe();
  await badge(true);
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "free", badge: false });
  expect(await shown()).toBe(true);
  await expect(call(updateBranding, as(), { poweredBy: false })).rejects.toMatchObject({ status: 400 });
});

test("removed, in Tuti or in Stripe, the badge is back", async () => {
  const subscription = await subscribe();
  await badge(true);
  expect(await badge(false)).toEqual({ on: false });
  expect(items(subscription)).toEqual([FAKE_STRIPE_PRICES.STRIPE_PRICE_PRO_MONTHLY.id]);
  expect(await shown()).toBe(true);
  // Added again, then removed in Stripe's dashboard: its webhook says so.
  await badge(true);
  const item = stripe.subscriptions.get(subscription)!.items.data[1]!;
  stripe.subscriptions.get(subscription)!.items.data.pop();
  expect(item.price.id).toBe(FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_MONTHLY.id);
  await deliver(stripe.update(subscription, {}));
  expect(await shown()).toBe(true);
});

test("with the add-on, the team may untick and tick the badge in Customize", async () => {
  await subscribe();
  await badge(true);
  await call(updateBranding, as(), { poweredBy: true });
  expect(await shown()).toBe(true);
  await call(updateBranding, as(), { poweredBy: false });
  expect(await shown()).toBe(false);
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { poweredBy: true } })).toEqual({ poweredBy: false });
});
