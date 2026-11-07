import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { startStripeFake, type FakeStripeEvent, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import LicensePage from "@/app/(marketing)/license/page";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { EmptyState } from "@/components/empty-state";
import { testLicensePrivateKey } from "@/test/license";

import { installationId, licenseClaimHash } from "./license";
import { buyLicense } from "./license-checkout";
import { refreshLicense } from "./license-server";

/**
 * Self-hosted licences bought on tuti.so/license (docs/plan.md, Licences): Stripe Checkout for the
 * project on the installation the link names, on while its subscription is live.
 */

let stripe: StripeFake;
let ids: { installation: string; project: string };

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(() => {
  for (const [name, value] of Object.entries({ ...stripe.env, LICENSE_PRIVATE_KEY: testLicensePrivateKey, APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  ids = { installation: `inst-${randomUUID()}`, project: `proj-${randomUUID()}` };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const deliver = async (...events: FakeStripeEvent[]) => {
  for (const { body, headers } of events) {
    expect((await webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }
};

/** Where buyLicense sent the buyer. */
async function buy(interval?: "month" | "year", claim?: string): Promise<string> {
  const form = new FormData();
  form.set("installation", ids.installation);
  form.set("project", ids.project);
  if (interval) {
    form.set("interval", interval);
  }
  if (claim) {
    form.set("claim", claim);
  }
  try {
    await buyLicense(form);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT;")) {
      return digest.split(";")[2]!;
    }
    throw error;
  }
  throw new Error("buyLicense didn't redirect");
}

/** Buys the licence and pays for it; returns its subscription. */
async function bought(): Promise<string> {
  await buy();
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  return session.subscription!;
}

const license = () => prisma.license.findUnique({ where: { installationId_projectId: { installationId: ids.installation, projectId: ids.project } } });
/** The installation's first renewal (with its licenseSecret, `secret`): a key, or why not. */
const claim = (secret?: string) => refreshLicense({ ...ids, token: null, requestId: randomUUID(), claim: secret });

test("bought with Stripe Checkout at the add-on's monthly price: once paid, the installation's renewals get keys", async () => {
  expect(await buy()).toBe(stripe.sessions.at(-1)!.url);
  const session = stripe.sessions.at(-1)!;
  expect(session).toMatchObject({ mode: "subscription", price: stripe.env.STRIPE_PRICE_BADGE_MONTHLY, metadata: { licenseInstallation: ids.installation, licenseProject: ids.project } });
  expect(await claim()).toEqual({ error: "not_licensed" });

  await deliver(...stripe.pay(session.id));
  expect(await license()).toMatchObject({ active: true, stripeSubscriptionId: session.subscription });
  expect(await claim()).toMatchObject({ key: expect.any(String) });
  // Its buyer may have several: Stripe's portal says which project and installation this one is for.
  expect(stripe.subscriptions.get(session.subscription!)!.description).toBe(`Tuti licence for project ${ids.project} on installation ${ids.installation}`);
  // A licence's invoice gives no AI credits: it's no project's plan here.
  expect(await prisma.aiCreditGrant.count({ where: { stripeInvoiceId: { not: null } } })).toBe(0);
});

test("or yearly, at the add-on's yearly price; without that price, a yearly one isn't sold", async () => {
  await buy("year");
  const session = stripe.sessions.at(-1)!;
  expect(session).toMatchObject({ price: stripe.env.STRIPE_PRICE_BADGE_YEARLY, metadata: { licenseInstallation: ids.installation } });
  await deliver(...stripe.pay(session.id));
  expect(await license()).toMatchObject({ active: true, stripeSubscriptionId: session.subscription });

  ids.project = `proj-${randomUUID()}`;
  vi.stubEnv("STRIPE_PRICE_BADGE_YEARLY", "");
  const sessions = stripe.sessions.length;
  expect(await buy("year")).toBe(`https://app.tuti.example/license?installation=${ids.installation}&project=${ids.project}`);
  expect(stripe.sessions.length).toBe(sessions);
});

test("cancelled in Stripe, renewals are refused, so the key lapses; bought again, it's back", async () => {
  const subscription = await bought();
  await deliver(stripe.update(subscription, { status: "canceled" }));
  expect(await license()).toMatchObject({ active: false });
  expect(await claim()).toEqual({ error: "not_licensed" });

  const again = await bought();
  expect(await license()).toMatchObject({ active: true, stripeSubscriptionId: again });
});

test("not sold twice: a licence that's on sends the buyer back to the page instead of Stripe", async () => {
  await bought();
  const sessions = stripe.sessions.length;
  expect(await buy()).toBe(`https://app.tuti.example/license?installation=${ids.installation}&project=${ids.project}`);
  expect(stripe.sessions.length).toBe(sessions);
});

test("a second live subscription for it (two checkouts paid at once) changes nothing, and ending it leaves the licence on", async () => {
  await buy();
  await buy();
  const [first, second] = stripe.sessions.slice(-2);
  await deliver(...stripe.pay(first!.id), ...stripe.pay(second!.id));
  expect(await license()).toMatchObject({ active: true, stripeSubscriptionId: first!.subscription });
  await deliver(stripe.update(second!.subscription!, { status: "canceled" }));
  expect(await license()).toMatchObject({ active: true });
});

test("activated by hand, then paid for: the subscription holds it from then on", async () => {
  await prisma.license.create({ data: { installationId: ids.installation, projectId: ids.project, active: false } });
  const subscription = await bought();
  expect(await license()).toMatchObject({ active: true, stripeSubscriptionId: subscription });
});

test("its month refunded in full or disputed ends the subscription, and the licence with it", async () => {
  const subscription = await bought();
  const [invoice] = [...stripe.invoices.values()].filter((each) => each.parent.subscription_details.subscription === subscription);
  await deliver(stripe.refund(stripe.chargeFor(invoice!.id).id));
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await license()).toMatchObject({ active: false });
});

test("a disputed month ends it too, and renewals are refused", async () => {
  const subscription = await bought();
  const [invoice] = [...stripe.invoices.values()].filter((each) => each.parent.subscription_details.subscription === subscription);
  await deliver(stripe.dispute(stripe.chargeFor(invoice!.id).id));
  expect(stripe.subscriptions.get(subscription)!.status).toBe("canceled");
  expect(await license()).toMatchObject({ active: false });
  expect(await claim()).toEqual({ error: "not_licensed" });
});

test("bought from an installation's link, only that installation (which has the secret behind the link's claim) can claim it first", async () => {
  const secret = randomUUID();
  await buy("month", licenseClaimHash(secret));
  const session = stripe.sessions.at(-1)!;
  expect(session.metadata).toMatchObject({ licenseClaim: licenseClaimHash(secret) });
  await deliver(...stripe.pay(session.id));

  // Knowing the ids isn't enough.
  expect(await claim()).toEqual({ error: "in_use" });
  expect(await claim(randomUUID())).toEqual({ error: "in_use" });
  // Its answer lost, the installation's retry (same request id, with the secret) gets it again.
  const requestId = randomUUID();
  const first = await refreshLicense({ ...ids, token: null, requestId, claim: secret });
  expect(first).toMatchObject({ key: expect.any(String) });
  expect(await refreshLicense({ ...ids, token: null, requestId, claim: secret })).toMatchObject({ token: (first as { token: string }).token });
  expect(await refreshLicense({ ...ids, token: null, requestId })).toEqual({ error: "in_use" });
});

test("cancelled, then bought again from a link without a claim (an older release's), it keeps the claim it had", async () => {
  const secret = randomUUID();
  await buy("month", licenseClaimHash(secret));
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  await deliver(stripe.update(session.subscription!, { status: "canceled" }));
  expect(await license()).toMatchObject({ active: false });

  await bought();
  expect(await license()).toMatchObject({ active: true, claimHash: licenseClaimHash(secret) });
  expect(await claim()).toEqual({ error: "in_use" });
  expect(await claim(secret)).toMatchObject({ key: expect.any(String) });
});

test("a link whose claim isn't one is sent back to Tuti, not round to the same buy form again", async () => {
  const sessions = stripe.sessions.length;
  const back = new URL(await buy("month", "not a claim"));
  expect(stripe.sessions.length).toBe(sessions);
  const page = (await LicensePage({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(back.searchParams)) } as PageProps<"/license">)) as React.ReactElement<
    React.ComponentProps<typeof EmptyState>
  >;
  expect(page.type).toBe(EmptyState);
  expect(page.props.title).toBe("Open this page from your Tuti");
});

test("Tuti's cloud sells and renews no licence for itself: hiding the badge there is the add-on on a paid plan", async () => {
  vi.stubEnv("PLANS", "on");
  ids.installation = await installationId();
  const sessions = stripe.sessions.length;
  expect(await buy()).toBe(`https://app.tuti.example/license?installation=${ids.installation}&project=${ids.project}`);
  expect(stripe.sessions.length).toBe(sessions);
  // Nor one activated by hand.
  await prisma.license.create({ data: { installationId: ids.installation, projectId: ids.project } });
  expect(await claim()).toEqual({ error: "not_licensed" });
  expect(await license()).toMatchObject({ generation: 0 });
});

test("at most 20 checkouts in any minute across everyone (the page is public): more are asked to try again in a moment", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const at = (seconds: number) => vi.setSystemTime(start + seconds * 1000);
  // A minute after the other tests' checkouts.
  const start = Date.now() + 61_000;
  const buyOne = () => {
    ids.project = `proj-${randomUUID()}`;
    return buy();
  };
  try {
    const sessions = stripe.sessions.length;
    at(0);
    expect(await buyOne()).not.toContain("/license?");
    at(50);
    for (let i = 0; i < 19; i++) {
      expect(await buyOne()).not.toContain("/license?");
    }
    expect(await buyOne()).toContain("failed=1");
    // A minute after the first: only its place is free again, as the other 19 are still in the last minute.
    at(61);
    expect(await buyOne()).not.toContain("/license?");
    expect(await buyOne()).toContain("failed=1");
    expect(stripe.sessions.length).toBe(sessions + 21);
  } finally {
    vi.useRealTimers();
  }
});

test("without Stripe, or for ids that aren't ones, nothing is sold: back to the page, which says to email", async () => {
  vi.stubEnv("STRIPE_PRICE_BADGE_MONTHLY", "");
  const sessions = stripe.sessions.length;
  expect(await buy()).toContain("/license?");
  vi.stubEnv("STRIPE_PRICE_BADGE_MONTHLY", stripe.env.STRIPE_PRICE_BADGE_MONTHLY!);
  ids.project = "not an id";
  expect(await buy()).toContain("/license?");
  expect(stripe.sessions.length).toBe(sessions);
});
