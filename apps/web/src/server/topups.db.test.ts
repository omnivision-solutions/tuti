import { prisma } from "@tuti/db";
import { creditBalance } from "@tuti/jobs";
import { FAKE_STRIPE_WEBHOOK_SECRET, startStripeFake, stripeSignature, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { topUpCredits } from "@/server/operations/credits";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** Buying AI credits (docs/plan.md, AI usage per project): a Stripe Checkout page, and its paid webhook giving the credits once. */

let stripe: StripeFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...stripe.env, AI_CREDITS: "on", APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const deliver = ({ body, headers }: { body: string; headers: Headers }) =>
  webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }));
const topUps = () =>
  prisma.aiCreditGrant.findMany({ where: { projectId: project.id, source: "TOPUP" }, select: { credits: true, remaining: true, expiresAt: true, paidCents: true, stripeSessionId: true } });

test("a top-up opens Stripe Checkout for the amount, at the top-up rate of the time", async () => {
  vi.stubEnv("AI_CREDITS_PER_TOPUP_DOLLAR", "50");
  const result = await call(topUpCredits, as(), { dollars: 10 });
  const session = stripe.sessions.at(-1)!;
  expect(result).toEqual({ url: session.url, dollars: 10, credits: 500 });
  expect(session).toMatchObject({
    mode: "payment",
    amount_total: 1000,
    currency: "usd",
    product: `500 AI credits for ${project.slug}`,
    metadata: { projectId: project.id, credits: "500", days: "365" },
    client_reference_id: project.id,
    customer_email: owner.email,
    success_url: `https://app.tuti.example/app/${project.slug}/settings/billing?paid=1`,
    cancel_url: `https://app.tuti.example/app/${project.slug}/settings/billing`,
  });
  // Nothing is given until Stripe says it's paid.
  expect(await topUps()).toEqual([]);
});

test("only whole dollars from $5 to $1,000; off without Stripe or credits", async () => {
  for (const dollars of [4, 1001, 2.5]) {
    await expect(call(topUpCredits, as(), { dollars })).rejects.toMatchObject({ status: 400 });
  }
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  await expect(call(topUpCredits, as(), { dollars: 10 })).rejects.toMatchObject({ status: 503, code: "topups_unavailable" });
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", FAKE_STRIPE_WEBHOOK_SECRET);
  vi.stubEnv("AI_CREDITS", "");
  await expect(call(topUpCredits, as(), { dollars: 10 })).rejects.toMatchObject({ status: 503 });
  expect(stripe.sessions.filter((session) => session.client_reference_id === project.id)).toEqual([]);
});

test("paid, the project gets its credits once, lasting a year, however often Stripe says so", async () => {
  await call(topUpCredits, as(), { dollars: 25 });
  const { id } = stripe.sessions.at(-1)!;
  expect((await deliver(stripe.event(id))).status).toBe(200);
  expect((await deliver(stripe.event(id))).status).toBe(200);
  const grants = await topUps();
  expect(grants).toEqual([expect.objectContaining({ paidCents: 2500, stripeSessionId: id })]);
  expect(grants[0]!.credits.toNumber()).toBe(2500);
  expect(grants[0]!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(364 * 86_400_000);
  expect((await creditBalance(project.id)).balance).toBe(2500);
});

test("a payment that isn't through yet gives nothing; its later success does", async () => {
  await call(topUpCredits, as(), { dollars: 10 });
  const { id } = stripe.sessions.at(-1)!;
  expect((await deliver(stripe.event(id, "checkout.session.completed", "unpaid"))).status).toBe(200);
  expect(await topUps()).toEqual([]);
  expect((await deliver(stripe.event(id, "checkout.session.async_payment_succeeded"))).status).toBe(200);
  expect(await topUps()).toHaveLength(1);
});

test("only events Stripe signed, in the last 5 minutes, are read", async () => {
  await call(topUpCredits, as(), { dollars: 10 });
  const { body } = stripe.event(stripe.sessions.at(-1)!.id);
  const send = (signature: string) => deliver({ body, headers: new Headers({ "stripe-signature": signature }) });
  expect((await send(stripeSignature(body, "whsec_someone_else"))).status).toBe(400);
  expect((await send(stripeSignature(body, FAKE_STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600))).status).toBe(400);
  expect((await send(stripeSignature(`${body} `))).status).toBe(400);
  expect((await send("t=1,v0=abc")).status).toBe(400);
  expect(await topUps()).toEqual([]);
  // Without top-ups set up, there's no webhook.
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  expect((await send(stripeSignature(body))).status).toBe(404);
});

test("a paid top-up for a project deleted meanwhile is answered, and gives nothing", async () => {
  await call(topUpCredits, as(), { dollars: 10 });
  const { id } = stripe.sessions.at(-1)!;
  await prisma.project.delete({ where: { id: project.id } });
  expect((await deliver(stripe.event(id))).status).toBe(200);
  expect(await prisma.aiCreditGrant.count({ where: { stripeSessionId: id } })).toBe(0);
});
