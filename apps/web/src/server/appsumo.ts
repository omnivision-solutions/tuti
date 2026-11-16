import { createHmac, timingSafeEqual } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { applyPlanLicense } from "@tuti/jobs";
import { appsumoTierPlan, log } from "@tuti/shared";

import { signValue } from "@/lib/signed";
import { appUrl } from "@/lib/hosts";

/**
 * AppSumo's lifetime deals (docs/plan.md, Plan licenses), on with APPSUMO_API_KEY: its webhook makes and changes plan
 * licenses (source "appsumo", keyed by AppSumo's license key), and its sign-in (OAuth, with APPSUMO_CLIENT_ID and
 * APPSUMO_CLIENT_SECRET) tells which license a buyer is redeeming, to claim it to their account.
 */

export const APPSUMO = "appsumo";

/** How far a webhook's timestamp may be from now: older ones (a replay) are refused. */
const WINDOW_MS = 5 * 60_000;

const appsumoUrl = () => (process.env.APPSUMO_URL || "https://appsumo.com").replace(/\/+$/, "");

/** Where AppSumo sends buyers back (its OAuth redirect URL, registered with AppSumo as it is here). */
export const appsumoRedirectUri = () => new URL("/api/appsumo/redirect", appUrl()).toString();

/**
 * Whether AppSumo signed `body`: X-Appsumo-Signature is the HMAC-SHA256 of X-Appsumo-Timestamp then the raw body,
 * keyed with the API key, and the timestamp (seconds, or milliseconds) is within 5 minutes of now.
 */
export function appsumoSigned(body: string, timestamp: string | null, signature: string | null, key: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false;
  }
  const at = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Math.abs(now - at) > WINDOW_MS) {
    return false;
  }
  const digest = createHmac("sha256", key).update(timestamp + body).digest();
  // Hex, as AppSumo's examples give it (either case); base64 too, should it send that.
  const given = signature.trim();
  return [
    [given.toLowerCase(), digest.toString("hex")],
    [given, digest.toString("base64")],
  ].some(([one, wanted]) => Buffer.byteLength(one!) === Buffer.byteLength(wanted!) && timingSafeEqual(Buffer.from(one!), Buffer.from(wanted!)));
}

export type AppsumoEvent = {
  event: string;
  license_key?: string;
  prev_license_key?: string;
  tier?: number;
  test?: boolean;
  parent_license_key?: string;
  extra?: { reason?: string };
};

/** A webhook's body, JSON or form-encoded (AppSumo sends either); null when it isn't one. */
export function readAppsumoEvent(body: string, contentType: string | null): AppsumoEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = contentType?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(body)) : (JSON.parse(body) as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || typeof raw.event !== "string") {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const tier = Number(raw.tier);
  return {
    event: raw.event,
    license_key: text(raw.license_key),
    prev_license_key: text(raw.prev_license_key),
    tier: Number.isInteger(tier) && tier > 0 ? tier : undefined,
    test: raw.test === true || raw.test === "true",
    parent_license_key: text(raw.parent_license_key),
    extra: typeof raw.extra === "object" && raw.extra ? (raw.extra as { reason?: string }) : undefined,
  };
}

/** A tier the billing file doesn't map to a plan: the webhook fails, so AppSumo tries again once the file has it. */
export class UnknownTier extends Error {}

/**
 * Applies one of AppSumo's events, idempotently (AppSumo retries until it hears back):
 * - purchase and activate: the license, made unclaimed with its tier's plan (purchase may not say the tier; activate
 *   does), or its plan brought in step;
 * - upgrade and downgrade: a new key for the license with the previous one (`prev_license_key`), on the new tier's plan,
 *   keeping its holder and project; not revoked, as the previous key's deactivation (sent with it, in either order)
 *   may have revoked it;
 * - deactivate: revoked (a refund), its project back on its own plan; an old key after an upgrade finds nothing;
 * - migrate, and anything about add-ons (we sell none): nothing.
 * Test events change nothing.
 */
/**
 * Takes each key's lock for the rest of `tx`, in one order: one event per license key at a time, so a refund and an
 * activation arriving together for a key we haven't seen yet can't both see no row.
 */
async function lockKeys(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...keys].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${key}))`;
  }
}

/**
 * A key an upgrade replaced keeps a row of its own, revoked, with the key that replaced it (metadata.replacedBy): its
 * late or repeated events (an activation, an older upgrade's retry) find it and change nothing, never making a second license.
 */
type Row = { id: string; externalKey: string; userId: string | null; projectId: string | null; revokedAt: Date | null; replacedBy: string | null };
const rowsFor = (tx: Prisma.TransactionClient, keys: string[]) => tx.$queryRaw<Row[]>`
  SELECT id, "externalKey", "userId", "projectId", "revokedAt", metadata->>'replacedBy' AS "replacedBy" FROM plan_license
  WHERE source = ${APPSUMO} AND "externalKey" = ANY(${keys}) FOR UPDATE`;

export async function applyAppsumoEvent(event: AppsumoEvent): Promise<void> {
  const key = event.license_key;
  if (event.test || !key || event.parent_license_key) {
    return;
  }
  // Only events that give a plan need the tier's: a deactivation (a refund) works whatever the file says now.
  const givesPlan = ["purchase", "activate", "upgrade", "downgrade"].includes(event.event);
  const plan = !givesPlan || event.tier === undefined ? null : appsumoTierPlan(event.tier);
  if (givesPlan && event.tier !== undefined && !plan) {
    throw new UnknownTier(`AppSumo's tier ${event.tier} isn't in the billing file's licenses.appsumo.tiers`);
  }
  const metadata = { tier: event.tier ?? null, event: event.event, reason: event.extra?.reason ?? null };
  switch (event.event) {
    case "purchase":
    case "activate": {
      if (!plan) {
        return;
      }
      await prisma.$transaction(async (tx) => {
        await lockKeys(tx, [key]);
        await tx.planLicense.createMany({ data: [{ source: APPSUMO, externalKey: key, plan, metadata }], skipDuplicates: true });
        const [row] = await rowsFor(tx, [key]);
        if (row!.replacedBy) {
          return;
        }
        await tx.planLicense.update({ where: { id: row!.id }, data: { plan, metadata } });
        await applyPlanLicense(tx, row!.id);
      });
      return;
    }
    case "upgrade":
    case "downgrade": {
      if (!plan) {
        return;
      }
      const keys = [key, ...(event.prev_license_key ? [event.prev_license_key] : [])];
      await prisma.$transaction(async (tx) => {
        await lockKeys(tx, keys);
        const rows = await rowsFor(tx, keys);
        const own = rows.find((one) => one.externalKey === key);
        if (own?.replacedBy) {
          return; // An older upgrade's retry: its new key has been replaced since.
        }
        const previous = rows.find((one) => one.externalKey !== key && !one.replacedBy);
        // The previous key's license takes the new key: its holder and project carry over. The new key's own row is a retry
        // (the previous one renamed already), or one the new key's activation made before the upgrade arrived: that one
        // goes, its holder kept, unless it's on a project or another account holds the previous (support sorts that out).
        const early = own && previous && !own.projectId && (!own.userId || !previous.userId || own.userId === previous.userId);
        if (early) {
          await tx.planLicense.delete({ where: { id: own.id } });
        }
        if (own && previous && !early) {
          log.error("An AppSumo upgrade's new key is on another account or project than the license it replaces: both kept, for support to merge", { licenseId: own.id, previousLicenseId: previous.id });
        }
        const row = early ? previous : (own ?? previous);
        if (!row) {
          await tx.planLicense.createMany({ data: [{ source: APPSUMO, externalKey: key, plan, metadata }], skipDuplicates: true });
          return;
        }
        // The previous key's deactivation doesn't count against the license under its new key, but the new key's own
        // (a refund of the upgrade, before this upgrade or its retry) does.
        const revokedAt = row === previous ? (early ? own.revokedAt : null) : row.revokedAt;
        await tx.planLicense.update({ where: { id: row.id }, data: { externalKey: key, plan, revokedAt, userId: row.userId ?? (early ? own.userId : null), metadata: { ...metadata, previousKey: event.prev_license_key ?? null } } });
        if (row === previous) {
          await tx.planLicense.create({ data: { source: APPSUMO, externalKey: previous.externalKey, plan: "", revokedAt: new Date(), metadata: { replacedBy: key } } });
        }
        await applyPlanLicense(tx, row.id);
      });
      return;
    }
    case "deactivate": {
      await prisma.$transaction(async (tx) => {
        await lockKeys(tx, [key]);
        const [row] = await rowsFor(tx, [key]);
        if (row?.replacedBy) {
          return; // An upgraded license's old key: the license has the new one now.
        }
        if (!row) {
          // A key we haven't heard of (its activation late, or failing for a tier the file lacks): kept revoked, so its
          // activation can't bring it to life.
          const tier = event.tier === undefined ? null : appsumoTierPlan(event.tier);
          await tx.planLicense.createMany({ data: [{ source: APPSUMO, externalKey: key, plan: tier ?? "", revokedAt: new Date(), metadata }], skipDuplicates: true });
          return;
        }
        await tx.planLicense.update({ where: { id: row.id }, data: { revokedAt: new Date(), metadata } });
        await applyPlanLicense(tx, row.id);
      });
      return;
    }
  }
}

/** How long a buyer has to sign in or sign up and claim the license AppSumo's sign-in named. */
const CLAIM_SECONDS = 60 * 60;

/** A claim for license `key` from `source`, for the redeem page (and through sign-in or sign-up, in its address). */
export const claimToken = (source: string, key: string) => signValue("plan-license-claim", [source, key], CLAIM_SECONDS);

/**
 * The license key AppSumo's sign-in gave `code` (single-use): its token for the code, then the key. Null when AppSumo
 * refuses (an old or used code) or can't be reached.
 */
export async function appsumoLicenseKey(code: string): Promise<string | null> {
  const clientId = process.env.APPSUMO_CLIENT_ID;
  const clientSecret = process.env.APPSUMO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }
  try {
    const token = await fetch(`${appsumoUrl()}/openid/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: appsumoRedirectUri(), grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    const { access_token: accessToken } = (await token.json().catch(() => ({}))) as { access_token?: string };
    if (!token.ok || !accessToken) {
      log.warn("AppSumo refused a sign-in's code", { status: token.status });
      return null;
    }
    const answer = await fetch(`${appsumoUrl()}/openid/license_key/?access_token=${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(15_000) });
    const { license_key: licenseKey } = (await answer.json().catch(() => ({}))) as { license_key?: string };
    if (!answer.ok || !licenseKey) {
      log.warn("AppSumo gave no license key for a sign-in", { status: answer.status });
      return null;
    }
    return licenseKey;
  } catch (error) {
    log.warn("AppSumo's sign-in couldn't be finished", { error });
    return null;
  }
}
