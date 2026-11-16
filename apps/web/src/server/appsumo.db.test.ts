import { prisma } from "@tuti/db";
import { grantCredits } from "@tuti/jobs";
import { appsumoWebhook, type AppsumoFake, billingFile, startAppsumoFake, withAppsumoPlans } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { GET as redirectRoute } from "@/app/api/appsumo/redirect/route";
import { POST as webhookRoute } from "@/app/api/appsumo/webhook/route";
import RedeemPage from "@/app/app/(account-pages)/licenses/redeem/page";
import { actAs, createProject, redirectTarget, signUp } from "@/test/helpers";

import { appsumoSigned, claimToken } from "./appsumo";
import { assignPlanLicense, claimPlanLicense, unassignPlanLicense } from "./plan-licenses";

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
/** The licenses with these keys, leaving out the revoked rows replaced keys keep. */
const licensesFor = async (keys: string[]) =>
  (await prisma.planLicense.findMany({ where: { externalKey: { in: keys } } })).filter((one) => !(one.metadata as { replacedBy?: string }).replacedBy);
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

test("a purchase that says its tier makes the license, before any activation", async () => {
  const key = crypto.randomUUID();
  await deliver({ event: "purchase", license_key: key, tier: 1 });
  expect(await find(key)).toMatchObject({ plan: "appsumo-1", userId: null, revokedAt: null });
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
  expect(await find(key)).toMatchObject({ revokedAt: expect.any(Date), userId: null, projectId: null, metadata: { replacedBy: next } });
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

/** The project's AI credits left from its license (PLAN) and from top-ups, and what was taken back. */
const creditsLeft = async (projectId: string) => {
  const grants = await prisma.creditGrant.findMany({ where: { projectId }, select: { source: true, remaining: true, takenBack: true } });
  const sum = (source: string, field: "remaining" | "takenBack") => grants.filter((one) => one.source === source).reduce((total, one) => total + one[field].toNumber(), 0);
  return { license: sum("PLAN", "remaining"), takenBack: sum("PLAN", "takenBack"), topups: sum("TOPUP", "remaining") };
};

test("a refund takes back the AI credits its license gave that are left, and leaves the project's top-ups", async () => {
  const { project, key } = await assigned();
  await grantCredits(project.id, "TOPUP", 500, { days: 365 });
  const spent = await prisma.creditGrant.findFirstOrThrow({ where: { projectId: project.id, source: "PLAN" } });
  await prisma.creditGrant.update({ where: { id: spent.id }, data: { remaining: 300 } });
  expect(await creditsLeft(project.id)).toEqual({ license: 300, takenBack: 0, topups: 500 });
  await deliver({ event: "deactivate", license_key: key, tier: 1, extra: { reason: "Refunded" } });
  expect(await creditsLeft(project.id)).toEqual({ license: 0, takenBack: 300, topups: 500 });
  // Said again (a retry), nothing more.
  await deliver({ event: "deactivate", license_key: key, tier: 1, extra: { reason: "Refunded" } });
  expect(await creditsLeft(project.id)).toEqual({ license: 0, takenBack: 300, topups: 500 });
});

test("the old key's deactivation before an upgrade takes the month's credits back, and the upgrade starts a new month", async () => {
  const { project, key, license } = await assigned();
  await deliver({ event: "deactivate", license_key: key, tier: 1 });
  expect(await creditsLeft(project.id)).toMatchObject({ license: 0, takenBack: 400 });
  const upgrade = { event: "upgrade", license_key: crypto.randomUUID(), prev_license_key: key, tier: 2 };
  await deliver(upgrade);
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ revokedAt: null, creditsThrough: expect.any(Date) });
  expect(await creditsLeft(project.id)).toMatchObject({ license: 1000 });
  // The upgrade committed but stopped before giving its month: AppSumo's retry gives it, once.
  await prisma.creditGrant.deleteMany({ where: { planLicenseId: license.id, credits: 1000 } });
  await prisma.planLicense.update({ where: { id: license.id }, data: { creditsThrough: null } });
  await deliver(upgrade);
  await deliver(upgrade);
  expect(await creditsLeft(project.id)).toMatchObject({ license: 1000 });
});

test("a refund after the license moved takes back what's left of its credits on the project it left too", async () => {
  const { owner, project: first, key, license } = await assigned();
  expect(await unassignPlanLicense(license.id)).toEqual({});
  const second = await createProject(owner);
  expect(await assignPlanLicense(second.slug, license.id)).toEqual({});
  // Moved mid-month: no new month on the second project.
  expect(await creditsLeft(first.id)).toMatchObject({ license: 400 });
  expect(await creditsLeft(second.id)).toMatchObject({ license: 0 });
  await deliver({ event: "deactivate", license_key: key, tier: 1 });
  expect(await creditsLeft(first.id)).toMatchObject({ license: 0, takenBack: 400 });
});

test("the new key's activation arriving before the upgrade: the upgrade still keeps the holder's license", async () => {
  const { owner, project, key, license } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "activate", license_key: next, tier: 2 });
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "deactivate", license_key: key });
  expect(await licensesFor([key, next])).toEqual([
    expect.objectContaining({ id: license.id, externalKey: next, plan: "appsumo-2", userId: owner.id, projectId: project.id, revokedAt: null }),
  ]);
  expect(await planOf(project.id)).toBe("appsumo-2");
});

test("credits from the new key's own license, before the upgrade merged it, are taken back by a refund too", async () => {
  const { owner, key } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "activate", license_key: next, tier: 2 });
  const early = await prisma.planLicense.update({ where: { source_externalKey: { source: "appsumo", externalKey: next } }, data: { userId: owner.id } });
  const other = await createProject(owner);
  expect(await assignPlanLicense(other.slug, early.id)).toEqual({});
  expect(await unassignPlanLicense(early.id)).toEqual({});
  expect(await creditsLeft(other.id)).toMatchObject({ license: 1000 });
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "deactivate", license_key: next });
  expect(await creditsLeft(other.id)).toMatchObject({ license: 0, takenBack: 1000 });
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
  expect(await licensesFor([second.key, later])).toEqual([
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

test("an activation for a key an upgrade replaced, arriving late, makes no second license", async () => {
  const { key, license } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "activate", license_key: key, tier: 1 });
  expect(await find(key)).toMatchObject({ revokedAt: expect.any(Date), userId: null, metadata: { replacedBy: next } });
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ externalKey: next, revokedAt: null });
});

test("the new key claimed by the same buyer before the upgrade arrives: the upgrade still lands on the license's project", async () => {
  const { owner, project, key, license } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "activate", license_key: next, tier: 2 });
  await prisma.planLicense.update({ where: { source_externalKey: { source: "appsumo", externalKey: next } }, data: { userId: owner.id, claimedAt: new Date() } });
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "deactivate", license_key: key });
  expect(await licensesFor([key, next])).toEqual([
    expect.objectContaining({ id: license.id, externalKey: next, plan: "appsumo-2", userId: owner.id, projectId: project.id, revokedAt: null }),
  ]);
  expect(await planOf(project.id)).toBe("appsumo-2");
});

/** Holds `key`'s lock in a transaction of its own (as an event mid-way would) until `release` is called. */
async function holdKeyLock(key: string) {
  let release!: () => void;
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holding = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${key}))`;
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 60_000 },
  );
  await isLocked;
  return { release: () => (release(), holding) };
}

/** Resolves once `count` sessions wait for `key`'s lock (Postgres's own view, not a clock). */
async function waitingOn(key: string, count: number) {
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = 7 AND objsubid = 2
        AND objid::bigint = (hashtext(${key})::bigint + 4294967296) % 4294967296`;
    if (waiting >= count) {
      return "waiting";
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("events for one key wait for each other: a refund and an activation can't both find no license", async () => {
  const key = crypto.randomUUID();
  const lock = await holdKeyLock(key);
  const refund = deliver({ event: "deactivate", license_key: key, tier: 1 });
  const activation = deliver({ event: "activate", license_key: key, tier: 1 });
  // Both wait for the lock; without it they'd be done first.
  expect(await Promise.race([waitingOn(key, 2), Promise.all([refund, activation]).then(() => "done")])).toBe("waiting");
  expect(await find(key)).toBeNull();
  await lock.release();
  await Promise.all([refund, activation]);
  expect(await find(key)).toMatchObject({ revokedAt: expect.any(Date) });
});

test("an older upgrade following its key to the newest one waits for that key's lock, so a refund of it isn't lost", async () => {
  const { key, license } = await assigned();
  const [second, third] = [crypto.randomUUID(), crypto.randomUUID()];
  await deliver({ event: "downgrade", license_key: third, prev_license_key: second, tier: 1 });
  const lock = await holdKeyLock(third);
  const upgrade = deliver({ event: "upgrade", license_key: second, prev_license_key: key, tier: 2 });
  expect(await Promise.race([waitingOn(third, 1), upgrade.then(() => "done")])).toBe("waiting");
  await lock.release();
  await upgrade;
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ externalKey: third });
});

test("the new key claimed before an upgrade from a key nobody claimed: the buyer keeps the license", async () => {
  const [first, next] = [crypto.randomUUID(), crypto.randomUUID()];
  await deliver({ event: "activate", license_key: first, tier: 1 });
  await deliver({ event: "activate", license_key: next, tier: 2 });
  const buyer = await signUp("Buyer");
  await prisma.planLicense.update({ where: { source_externalKey: { source: "appsumo", externalKey: next } }, data: { userId: buyer.id, claimedAt: new Date() } });
  await deliver({ event: "upgrade", license_key: next, prev_license_key: first, tier: 2 });
  expect(await licensesFor([first, next])).toEqual([expect.objectContaining({ externalKey: next, plan: "appsumo-2", userId: buyer.id, revokedAt: null })]);
});

test("two upgrades in a row: the first's retry and the first key's late events make no second license", async () => {
  const { owner, project, key, license } = await assigned();
  const second = crypto.randomUUID();
  const third = crypto.randomUUID();
  await deliver({ event: "upgrade", license_key: second, prev_license_key: key, tier: 2 });
  await deliver({ event: "downgrade", license_key: third, prev_license_key: second, tier: 1 });
  await deliver({ event: "activate", license_key: second, tier: 2 });
  await deliver({ event: "upgrade", license_key: second, prev_license_key: key, tier: 2 });
  await deliver({ event: "activate", license_key: key, tier: 1 });
  await deliver({ event: "deactivate", license_key: key });
  await deliver({ event: "deactivate", license_key: second });
  expect(await licensesFor([key, second, third])).toEqual([
    expect.objectContaining({ id: license.id, externalKey: third, plan: "appsumo-1", userId: owner.id, projectId: project.id, revokedAt: null }),
  ]);
  expect(await planOf(project.id)).toBe("appsumo-1");
  // The replaced keys can't be claimed: they read as deactivated.
  expect(await find(key)).toMatchObject({ revokedAt: expect.any(Date), userId: null });
});

test("an upgrade before either key's activation: the old key's late activation makes no second license", async () => {
  const key = crypto.randomUUID();
  const next = crypto.randomUUID();
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  await deliver({ event: "activate", license_key: key, tier: 1 });
  expect(await licensesFor([key, next])).toEqual([expect.objectContaining({ externalKey: next, plan: "appsumo-2", revokedAt: null })]);
});

test("two upgrades arriving in reverse order: the holder's license ends on the newest key and its plan", async () => {
  const { owner, project, key, license } = await assigned();
  const second = crypto.randomUUID();
  const third = crypto.randomUUID();
  await deliver({ event: "downgrade", license_key: third, prev_license_key: second, tier: 1 });
  await deliver({ event: "upgrade", license_key: second, prev_license_key: key, tier: 2 });
  await deliver({ event: "deactivate", license_key: key });
  await deliver({ event: "deactivate", license_key: second });
  expect(await licensesFor([key, second, third])).toEqual([
    expect.objectContaining({ id: license.id, externalKey: third, plan: "appsumo-1", userId: owner.id, projectId: project.id, revokedAt: null }),
  ]);
  expect(await planOf(project.id)).toBe("appsumo-1");
});

test("a refund landing between a claim's check and its claim: the license isn't claimed", async () => {
  const key = crypto.randomUUID();
  await deliver({ event: "activate", license_key: key, tier: 1 });
  const before = await find(key);
  await deliver({ event: "deactivate", license_key: key });
  // The claim read the license before the refund came.
  vi.spyOn(prisma.planLicense, "findUnique").mockResolvedValueOnce(before);
  actAs(await signUp("Buyer"));
  expect(await claimPlanLicense(claimToken("appsumo", key))).toEqual({ error: "This license changed on AppSumo just now. Redeem it from AppSumo again." });
  expect(await find(key)).toMatchObject({ userId: null, revokedAt: expect.any(Date) });
});

test("the new key already on another project when its upgrade arrives: the old license is revoked, so one purchase gives one plan", async () => {
  const { owner, project, key, license } = await assigned();
  const next = crypto.randomUUID();
  await deliver({ event: "activate", license_key: next, tier: 2 });
  const other = await createProject(owner);
  const nextLicense = await prisma.planLicense.update({ where: { source_externalKey: { source: "appsumo", externalKey: next } }, data: { userId: owner.id, claimedAt: new Date() } });
  expect(await assignPlanLicense(other.slug, nextLicense.id)).toEqual({});
  await deliver({ event: "upgrade", license_key: next, prev_license_key: key, tier: 2 });
  expect(await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } })).toMatchObject({ revokedAt: expect.any(Date), projectId: project.id });
  expect(await planOf(project.id)).toBeNull();
  expect(await planOf(other.id)).toBe("appsumo-2");
});

test("two upgrades in reverse order before the first key's activation: its late activation makes no second license", async () => {
  const [first, second, third] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await deliver({ event: "downgrade", license_key: third, prev_license_key: second, tier: 1 });
  await deliver({ event: "upgrade", license_key: second, prev_license_key: first, tier: 2 });
  await deliver({ event: "activate", license_key: first, tier: 1 });
  expect(await licensesFor([first, second, third])).toEqual([expect.objectContaining({ externalKey: third, plan: "appsumo-1", revokedAt: null })]);
});
