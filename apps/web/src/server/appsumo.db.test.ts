import { prisma } from "@tuti/db";
import { appsumoWebhook, type AppsumoFake, billingFile, startAppsumoFake, withAppsumoPlans } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { GET as redirectRoute } from "@/app/api/appsumo/redirect/route";
import { POST as webhookRoute } from "@/app/api/appsumo/webhook/route";
import RedeemPage from "@/app/app/(account-pages)/licenses/redeem/page";
import { actAs, createProject, redirectTarget, signUp } from "@/test/helpers";

import { appsumoSigned, claimToken } from "./appsumo";
import { assignPlanLicense, claimPlanLicense } from "./plan-licenses";

/** AppSumo's lifetime deals (docs/plan.md, Plan licenses): its webhook makes and changes licenses; its sign-in claims one to an account. */

let appsumo: AppsumoFake;

beforeAll(async () => {
  appsumo = await startAppsumoFake();
});
afterAll(() => appsumo.close());
beforeEach(() => {
  for (const [name, value] of Object.entries({ ...appsumo.env, BILLING_CONFIG: billingFile(withAppsumoPlans), APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
});

/** Delivers `payload` as AppSumo would; its answer's status and body. */
async function deliver(payload: Record<string, unknown>, options?: Parameters<typeof appsumoWebhook>[1]) {
  const { body, headers } = appsumoWebhook(payload, options);
  const response = await webhookRoute(new Request("https://app.tuti.example/api/appsumo/webhook", { method: "POST", body, headers }));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
}
const find = (key: string) => prisma.planLicense.findUnique({ where: { source_externalKey: { source: "appsumo", externalKey: key } } });
const planOf = async (projectId: string) => (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true, trialEndsAt: true } })).plan;

test("a purchase and its activation make an unclaimed license on the tier's plan, once however often they come", async () => {
  const key = crypto.randomUUID();
  // A purchase may not say its tier: nothing yet.
  expect(await deliver({ event: "purchase", license_key: key, license_status: "inactive" })).toEqual({ status: 200, body: { event: "purchase", success: true } });
  expect(await find(key)).toBeNull();
  for (let i = 0; i < 2; i++) {
    expect(await deliver({ event: "activate", license_key: key, tier: 2, license_status: "inactive", extra: { reason: "Purchased by the customer" } })).toEqual({
      status: 200,
      body: { event: "activate", success: true },
    });
  }
  expect(await prisma.planLicense.findMany({ where: { externalKey: key } })).toEqual([
    expect.objectContaining({ source: "appsumo", plan: "appsumo-2", userId: null, projectId: null, revokedAt: null, metadata: { tier: 2, event: "activate", reason: "Purchased by the customer" } }),
  ]);
});

test("only AppSumo's signature, from the last 5 minutes, is read; test events change nothing", async () => {
  const key = crypto.randomUUID();
  expect((await deliver({ event: "activate", license_key: key, tier: 1 }, { key: "someone-else" })).status).toBe(401);
  expect((await deliver({ event: "activate", license_key: key, tier: 1 }, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
  expect(await deliver({ event: "activate", license_key: key, tier: 1, test: true })).toEqual({ status: 200, body: { event: "activate", success: true } });
  expect(await deliver({ event: "deactivate", license_key: key, test: true })).toEqual({ status: 200, body: { event: "deactivate", success: true } });
  expect(await find(key)).toBeNull();
  // Without the API key, there's no webhook.
  vi.stubEnv("APPSUMO_API_KEY", "");
  expect((await deliver({ event: "activate", license_key: key, tier: 1 })).status).toBe(404);
});

test("a form-encoded event is read like JSON", async () => {
  const key = crypto.randomUUID();
  const body = new URLSearchParams({ event: "activate", license_key: key, tier: "1", test: "false" }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHmac } = await import("node:crypto");
  const signature = createHmac("sha256", appsumo.env.APPSUMO_API_KEY!).update(timestamp + body).digest("hex");
  const response = await webhookRoute(
    new Request("https://app.tuti.example/api/appsumo/webhook", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-appsumo-timestamp": timestamp, "x-appsumo-signature": signature },
    }),
  );
  expect(response.status).toBe(200);
  expect(await find(key)).toMatchObject({ plan: "appsumo-1" });
});

test("a tier the billing file doesn't map fails, so AppSumo tries again; add-ons and migrations are acknowledged", async () => {
  const key = crypto.randomUUID();
  expect((await deliver({ event: "activate", license_key: key, tier: 4 })).status).toBe(500);
  expect(await find(key)).toBeNull();
  expect(await deliver({ event: "purchase", license_key: key, tier: 1, parent_license_key: crypto.randomUUID(), partner_plan_name: "seats", unit_quantity: 5 })).toEqual({
    status: 200,
    body: { event: "purchase", success: true },
  });
  expect(await deliver({ event: "migrate", license_key: key, tier: 1, parent_license_key: crypto.randomUUID() })).toEqual({ status: 200, body: { event: "migrate", success: true } });
  expect(await find(key)).toBeNull();
});

/** A claimed license on tier 1, assigned to its holder's project. */
async function assigned() {
  const owner = await signUp("Buyer");
  actAs(owner);
  const project = await createProject(owner);
  const key = crypto.randomUUID();
  await deliver({ event: "activate", license_key: key, tier: 1 });
  const license = await prisma.planLicense.update({ where: { source_externalKey: { source: "appsumo", externalKey: key } }, data: { userId: owner.id } });
  expect(await assignPlanLicense(project.slug, license.id)).toEqual({});
  expect(await planOf(project.id)).toBe("appsumo-1");
  return { owner, project, key, license };
}

test("an upgrade gives the license its new key and plan, keeping its holder and project; the old key's deactivation doesn't revoke it", async () => {
  const { owner, project, key, license } = await assigned();
  const next = crypto.randomUUID();
  const upgrade = { event: "upgrade", license_key: next, prev_license_key: key, tier: 2 };
  expect(await deliver(upgrade)).toEqual({ status: 200, body: { event: "upgrade", success: true } });
  expect(await deliver({ event: "deactivate", license_key: key, tier: 1, extra: { reason: "Upgraded by the customer" } })).toEqual({ status: 200, body: { event: "deactivate", success: true } });
  // Said again (a retry), the same.
  await deliver(upgrade);
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ externalKey: next, plan: "appsumo-2", userId: owner.id, projectId: project.id, revokedAt: null });
  expect(await find(key)).toBeNull();
  expect(await planOf(project.id)).toBe("appsumo-2");
});

test("the old key's deactivation arriving before the upgrade: the upgrade brings the license back where it was", async () => {
  const { project, key, license } = await assigned();
  await deliver({ event: "deactivate", license_key: key, tier: 1 });
  expect(await planOf(project.id)).toBeNull();
  const next = crypto.randomUUID();
  await deliver({ event: "downgrade", license_key: next, prev_license_key: key, tier: 1 });
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ externalKey: next, projectId: project.id, revokedAt: null });
  expect(await planOf(project.id)).toBe("appsumo-1");
});

test("the new key's activation arriving before the upgrade: the upgrade still keeps the holder's license", async () => {
  const { owner, project, key, license } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "activate", license_key: next, tier: 2 });
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "deactivate", license_key: key });
  expect(await prisma.planLicense.findMany({ where: { externalKey: { in: [key, next] } } })).toEqual([
    expect.objectContaining({ id: license.id, externalKey: next, plan: "appsumo-2", userId: owner.id, projectId: project.id, revokedAt: null }),
  ]);
  expect(await planOf(project.id)).toBe("appsumo-2");
});

test("a refund of the upgrade itself holds, whatever order the upgrade comes in", async () => {
  // Upgraded, the upgrade refunded, then the upgrade said again (a retry): still revoked.
  const first = await assigned();
  const next = crypto.randomUUID();
  const upgrade = { event: "upgrade", license_key: next, prev_license_key: first.key, tier: 2 };
  await deliver(upgrade);
  await deliver({ event: "deactivate", license_key: next });
  await deliver(upgrade);
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: first.license.id } })).toMatchObject({ externalKey: next, revokedAt: expect.any(Date) });
  expect(await planOf(first.project.id)).toBeNull();

  // The new key activated and refunded before the upgrade arrives: the holder's license takes the key, revoked.
  const second = await assigned();
  const later = crypto.randomUUID();
  await deliver({ event: "activate", license_key: later, tier: 2 });
  await deliver({ event: "deactivate", license_key: later });
  await deliver({ event: "upgrade", license_key: later, prev_license_key: second.key, tier: 2 });
  expect(await prisma.planLicense.findMany({ where: { externalKey: { in: [second.key, later] } } })).toEqual([
    expect.objectContaining({ id: second.license.id, externalKey: later, revokedAt: expect.any(Date) }),
  ]);
  expect(await planOf(second.project.id)).toBeNull();
});

test("AppSumo's signature: the timestamp in seconds or milliseconds within 5 minutes, hex in either case or base64", async () => {
  const { createHmac } = await import("node:crypto");
  const now = Date.UTC(2026, 10, 15, 12);
  const body = '{"event":"activate"}';
  const sign = (timestamp: string, key = "k") => createHmac("sha256", key).update(timestamp + body).digest();
  const seconds = String(now / 1000);
  const millis = String(now);
  expect(appsumoSigned(body, seconds, sign(seconds).toString("hex"), "k", now)).toBe(true);
  expect(appsumoSigned(body, millis, sign(millis).toString("hex"), "k", now)).toBe(true);
  expect(appsumoSigned(body, seconds, sign(seconds).toString("hex").toUpperCase(), "k", now)).toBe(true);
  expect(appsumoSigned(body, seconds, sign(seconds).toString("base64"), "k", now)).toBe(true);
  // Another key, another body, too old or too far ahead, or missing.
  expect(appsumoSigned(body, seconds, sign(seconds, "other").toString("hex"), "k", now)).toBe(false);
  expect(appsumoSigned(`${body} `, seconds, sign(seconds).toString("hex"), "k", now)).toBe(false);
  expect(appsumoSigned(body, seconds, sign(seconds).toString("hex"), "k", now + 6 * 60_000)).toBe(false);
  expect(appsumoSigned(body, seconds, sign(seconds).toString("hex"), "k", now - 6 * 60_000)).toBe(false);
  expect(appsumoSigned(body, null, sign(seconds).toString("hex"), "k", now)).toBe(false);
  expect(appsumoSigned(body, seconds, null, "k", now)).toBe(false);
});

test("a deactivation (a refund) revokes the license: its project is back on its own plan, the license stays on it until unassigned", async () => {
  const { project, key, license } = await assigned();
  expect(await deliver({ event: "deactivate", license_key: key, license_status: "active", extra: { reason: "Refunded by the user" } })).toEqual({
    status: 200,
    body: { event: "deactivate", success: true },
  });
  await deliver({ event: "deactivate", license_key: key });
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ projectId: project.id, revokedAt: expect.any(Date) });
  expect(await planOf(project.id)).toBeNull();
  // A tier the billing file no longer maps doesn't stop a refund.
  const other = await assigned();
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    withAppsumoPlans(config);
    // Its plan still a license's (under another tier), so the file is valid.
    config.licenses!.appsumo!.tiers = { "2": "appsumo-2", "9": "appsumo-1" };
  }));
  expect((await deliver({ event: "deactivate", license_key: other.key, tier: 1 })).status).toBe(200);
  expect(await planOf(other.project.id)).toBeNull();
  // A key we haven't heard of: acknowledged, and kept revoked, so its activation arriving late gives nothing.
  const unheard = crypto.randomUUID();
  expect((await deliver({ event: "deactivate", license_key: unheard })).status).toBe(200);
  await deliver({ event: "activate", license_key: unheard, tier: 2 });
  expect(await find(unheard)).toMatchObject({ plan: "appsumo-2", revokedAt: expect.any(Date) });
  actAs(await signUp("Late buyer"));
  expect(await claimPlanLicense(claimToken("appsumo", unheard))).toEqual({ error: "This license was deactivated on AppSumo." });
});

test("the redirect answers AppSumo's check, and trades a buyer's code for a claim on their license", async () => {
  expect((await redirectRoute(new Request("https://app.tuti.example/api/appsumo/redirect"))).status).toBe(200);
  const key = crypto.randomUUID();
  const code = appsumo.code(key);
  const target = await redirectTarget(redirectRoute(new Request(`https://app.tuti.example/api/appsumo/redirect?code=${code}`)));
  expect(target).toMatch(/^\/app\/licenses\/redeem\?claim=/);
  expect(appsumo.requests.at(-1)).toMatchObject({ code, grant_type: "authorization_code", redirect_uri: "https://app.tuti.example/api/appsumo/redirect" });
  // The code is single-use: again, AppSumo refuses it.
  expect(await redirectTarget(redirectRoute(new Request(`https://app.tuti.example/api/appsumo/redirect?code=${code}`)))).toBe("/app/licenses/redeem?failed=1");
  // A key with a dot can't be carried in a claim (its fields are dot-separated): refused, not cut short.
  const dotted = appsumo.code(`${crypto.randomUUID()}.extra`);
  expect(await redirectTarget(redirectRoute(new Request(`https://app.tuti.example/api/appsumo/redirect?code=${dotted}`)))).toBe("/app/licenses/redeem?failed=1");
});

test("signed out, the redeem page sends the buyer to sign up and back", async () => {
  actAs(null);
  const claim = claimToken("appsumo", crypto.randomUUID());
  const target = await redirectTarget(RedeemPage({ searchParams: Promise.resolve({ claim }), params: Promise.resolve({}) } as unknown as PageProps<"/app/licenses/redeem">));
  expect(target).toBe(`/app/auth/sign-up?next=${encodeURIComponent(`/app/licenses/redeem?claim=${encodeURIComponent(claim)}`)}`);
});

test("a claim adds the license to the signed-in account, once: another account can't take it", async () => {
  const key = crypto.randomUUID();
  const claim = claimToken("appsumo", key);
  const buyer = await signUp("Buyer");
  actAs(buyer);
  expect(await claimPlanLicense(claim)).toEqual({ error: "We haven't heard from AppSumo about this license yet. Try again in a minute." });
  await deliver({ event: "activate", license_key: key, tier: 1 });
  expect(await redirectTarget(claimPlanLicense(claim))).toBe("/app/licenses");
  expect(await find(key)).toMatchObject({ userId: buyer.id, claimedAt: expect.any(Date) });
  // Again: still theirs.
  expect(await redirectTarget(claimPlanLicense(claim))).toBe("/app/licenses");
  actAs(await signUp("Someone else"));
  expect(await claimPlanLicense(claim)).toEqual({ error: "This license is on another Tuti account. Sign in to that one, or contact support." });
  expect(await find(key)).toMatchObject({ userId: buyer.id });
  // A forged claim isn't one, nor one over an hour old.
  expect(await claimPlanLicense(`${claim}x`)).toEqual({ error: "This link has expired. Redeem the license from AppSumo again." });
  const later = crypto.randomUUID();
  await deliver({ event: "activate", license_key: later, tier: 1 });
  const old = claimToken("appsumo", later);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61 * 60_000 });
  try {
    expect(await claimPlanLicense(old)).toEqual({ error: "This link has expired. Redeem the license from AppSumo again." });
  } finally {
    vi.useRealTimers();
  }
  expect(await find(later)).toMatchObject({ userId: null });
  actAs(null);
  expect(await claimPlanLicense(claim)).toEqual({ error: "Sign in to add the license to your account" });
});

test("a deactivated license can't be claimed", async () => {
  const key = crypto.randomUUID();
  await deliver({ event: "activate", license_key: key, tier: 1 });
  await deliver({ event: "deactivate", license_key: key });
  actAs(await signUp("Buyer"));
  expect(await claimPlanLicense(claimToken("appsumo", key))).toEqual({ error: "This license was deactivated on AppSumo." });
});
