import { prisma } from "@tuti/db";
import { billingFile, FAKE_STRIPE_PRICES, type FakeStripeEvent, startStripeFake, type StripeFake, withAppsumoPlans } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { branding } from "@/server/operations/branding";
import { getPlan, managePlan, setBadgeAddOn } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { applyAppsumoEvent } from "./appsumo";
import { assignPlanLicense, unassignPlanLicense } from "./plan-licenses";

/** A project given its plan by a plan license buys the "Powered by tuti" add-on on its own: a subscription holding only it. */

let stripe: StripeFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let licenseId: string;
let licenseKey: string;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...stripe.env, BILLING_CONFIG: billingFile(withAppsumoPlans), APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  actAs(owner);
  project = await createProject(owner);
  licenseKey = crypto.randomUUID();
  licenseId = (await prisma.planLicense.create({ data: { source: "appsumo", externalKey: licenseKey, plan: "appsumo-2", userId: owner.id } })).id;
  expect(await assignPlanLicense(project.slug, licenseId)).toEqual({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const deliver = async (...events: FakeStripeEvent[]) => {
  for (const { body, headers } of events) {
    expect((await webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }
};
const badge = (on: boolean) => call(setBadgeAddOn, as(), { on });
const shown = async () => (await branding({ id: project.id }))!.poweredBy;
const stored = () => prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, planStatus: true, badgeAddOn: true, stripeSubscriptionId: true, stripeCustomerId: true } });

/** Hides the badge: Checkout, paid. Its subscription. */
async function buy() {
  const { url } = await badge(true);
  const session = stripe.sessions.at(-1)!;
  expect(url).toBe(session.url);
  await deliver(...stripe.pay(session.id));
  return session.subscription!;
}

test("a licensed project's add-on is a Checkout for the badge alone; paid, it hides the badge and the license keeps the plan", async () => {
  const subscription = await buy();
  const session = stripe.sessions.at(-1)!;
  expect([session.price, session.subscription_metadata]).toEqual([FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_MONTHLY.id, { projectId: project.id }]);
  expect(await stored()).toMatchObject({ plan: "appsumo-2", planStatus: null, badgeAddOn: true, stripeSubscriptionId: subscription, stripeCustomerId: expect.any(String) });
  expect(await shown()).toBe(false);
  expect(await call(getPlan, as(), {})).toMatchObject({ plan: "appsumo-2", badge: true });
  // On already: no second Checkout.
  expect(await badge(true)).toEqual({ on: true });
  // Its card and invoices are in Stripe's portal.
  expect((await call(managePlan, as(), {})).url).toEqual(expect.any(String));
});

test("monthly where it's sold so, else yearly", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { withAppsumoPlans(config); delete config.badge!.month; }));
  await badge(true);
  expect(stripe.sessions.at(-1)!.price).toBe(FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_YEARLY.id);
});

test("monthly even when a yearly plan the project once had left its interval behind", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { planInterval: "year" } });
  await badge(true);
  expect(stripe.sessions.at(-1)!.price).toBe(FAKE_STRIPE_PRICES.STRIPE_PRICE_BADGE_MONTHLY.id);
});

test("removed, its subscription is cancelled and the badge is back; cancelled in Stripe, the same", async () => {
  const subscription = await buy();
  expect(await badge(false)).toEqual({ on: false });
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await shown()).toBe(true);
  expect(await stored()).toMatchObject({ plan: "appsumo-2", badgeAddOn: false });

  const again = await buy();
  await deliver(stripe.update(again, { status: "canceled" }));
  expect(await stored()).toMatchObject({ plan: "appsumo-2", badgeAddOn: false });
  expect(await shown()).toBe(true);
});

test("paid for a project whose license was unassigned meanwhile: cancelled for a refund, and nothing changes", async () => {
  await badge(true);
  const session = stripe.sessions.at(-1)!;
  expect(await unassignPlanLicense(licenseId)).toEqual({});
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await deliver(...stripe.pay(session.id));
  expect(stripe.subscriptions.get(session.subscription!)!.status).toBe("canceled");
  expect(errors.mock.calls.flat().join(" ")).toContain("refund its payment");
  expect(await stored()).toMatchObject({ plan: null, badgeAddOn: false });
});

test("a second Checkout paid (two tabs, or opened again before the first's webhook): cancelled for a refund, and the first stays the project's", async () => {
  await badge(true);
  await badge(true);
  const [first, second] = stripe.sessions.slice(-2);
  await deliver(...stripe.pay(first.id));
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await deliver(...stripe.pay(second.id));
  expect(stripe.subscriptions.get(second.subscription!)!.status).toBe("canceled");
  expect(stripe.subscriptions.get(first.subscription!)!.status).toBe("active");
  expect(errors.mock.calls.flat().join(" ")).toContain("refund its payment");
  expect(await stored()).toMatchObject({ plan: "appsumo-2", badgeAddOn: true, stripeSubscriptionId: first.subscription });
});

test("paid for a project on a paid plan since its Checkout opened: cancelled for a refund, and the plan's subscription stays", async () => {
  await badge(true);
  const session = stripe.sessions.at(-1)!;
  // On a plan meanwhile, as one set by hand (by quote) is.
  await prisma.project.update({ where: { id: project.id }, data: { plan: "pro", planStatus: "active", stripeSubscriptionId: "sub_plan" } });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await deliver(...stripe.pay(session.id));
  expect(stripe.subscriptions.get(session.subscription!)!.status).toBe("canceled");
  expect(errors.mock.calls.flat().join(" ")).toContain("refund its payment");
  expect(await stored()).toMatchObject({ plan: "pro", badgeAddOn: false, stripeSubscriptionId: "sub_plan" });
});

test("it ends with the license: unassigned, or revoked by AppSumo; the license goes back on with no subscription left charging", async () => {
  const subscription = await buy();
  expect(await unassignPlanLicense(licenseId)).toEqual({});
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await stored()).toMatchObject({ plan: null, badgeAddOn: false });
  expect(await shown()).toBe(true);

  expect(await assignPlanLicense(project.slug, licenseId)).toEqual({});
  const next = await buy();
  await applyAppsumoEvent({ event: "deactivate", license_key: licenseKey });
  expect(stripe.subscriptions.get(next)!.status).toBe("canceled");
  expect(await stored()).toMatchObject({ plan: null, badgeAddOn: false });
  expect(await shown()).toBe(true);
});

test("a live add-on doesn't keep a license off the project, and its webhook after the license moves back on hides the badge again", async () => {
  const subscription = await buy();
  // Stripe couldn't cancel it when the license was unassigned.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    init?.method === "DELETE" ? Response.json({ error: { message: "Stripe is down" } }, { status: 500 }) : realFetch(input, init),
  );
  expect(await unassignPlanLicense(licenseId)).toEqual({});
  spy.mockRestore();
  expect(await stored()).toMatchObject({ badgeAddOn: false });
  expect(await assignPlanLicense(project.slug, licenseId)).toEqual({});
  await deliver(stripe.update(subscription, {}));
  expect(await stored()).toMatchObject({ plan: "appsumo-2", badgeAddOn: true });
});

test("an upgrade's old key deactivated first keeps the add-on: the upgrade gives the license back with the badge still hidden", async () => {
  const subscription = await buy();
  await applyAppsumoEvent({ event: "deactivate", license_key: licenseKey, extra: { reason: "Upgraded by the customer" } });
  expect(stripe.subscriptions.get(subscription)!.status).toBe("active");
  await applyAppsumoEvent({ event: "upgrade", license_key: crypto.randomUUID(), prev_license_key: licenseKey, tier: 2 });
  expect(await stored()).toMatchObject({ plan: "appsumo-2", badgeAddOn: true });
  expect(await shown()).toBe(false);
});

test("an upgrade whose new key is another account's revokes the old license, and its add-on ends with it", async () => {
  const subscription = await buy();
  const other = await signUp("Other");
  const next = crypto.randomUUID();
  await prisma.planLicense.create({ data: { source: "appsumo", externalKey: next, plan: "appsumo-2", userId: other.id } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await applyAppsumoEvent({ event: "upgrade", license_key: next, prev_license_key: licenseKey, tier: 2 });
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await stored()).toMatchObject({ plan: null, badgeAddOn: false });
});

test("unassigning and AppSumo's deactivation wait for Stripe's webhook syncing the project, so neither misses the add-on it's recording", async () => {
  // Waiting on this project's lock 6 in this file's database (others share the server).
  const waiting = async () => {
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 6 AND objsubid = 2 AND objid::bigint = (hashtext(${project.id})::bigint + 4294967296) % 4294967296`;
      if (n > 0) {
        return "waiting";
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  for (const change of [() => unassignPlanLicense(licenseId), () => applyAppsumoEvent({ event: "deactivate", license_key: licenseKey })]) {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // The webhook's lock for the project, held as syncSubscription holds it.
    const webhook = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${project.id}))`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    const changing = change();
    expect(await Promise.race([waiting(), changing.then(() => "done")])).toBe("waiting");
    release();
    await webhook;
    await changing;
    await prisma.planLicense.update({ where: { id: licenseId }, data: { revokedAt: null } });
    expect(await assignPlanLicense(project.slug, licenseId)).toEqual({});
  }
});

test("revoked while Stripe can't be reached, the badge shows all the same, and the add-on is logged to cancel", async () => {
  await buy();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  await applyAppsumoEvent({ event: "deactivate", license_key: licenseKey });
  expect(await stored()).toMatchObject({ plan: null, badgeAddOn: false });
  expect(await shown()).toBe(true);
});

test("removed again after Stripe cancelled it but the sync failed: synced, so the badge shows", async () => {
  const subscription = await buy();
  stripe.subscriptions.get(subscription)!.status = "canceled";
  expect(await badge(false)).toEqual({ on: false });
  expect(await stored()).toMatchObject({ badgeAddOn: false });
  expect(await shown()).toBe(true);
});
