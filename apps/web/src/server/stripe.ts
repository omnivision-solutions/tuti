import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe, for AI credit top-ups (docs/plan.md, AI usage per project): a Checkout Session to pay, and
 * its webhook's signature. Two requests' worth of Stripe's API, so no SDK.
 */

const api = () => (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");

/** A one-time payment page for `cents` (USD) on Stripe Checkout; returns its URL. Throws on any failure. */
export async function createCheckout({
  cents,
  product,
  metadata,
  successUrl,
  cancelUrl,
  email,
  reference,
}: {
  cents: number;
  product: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  email: string | null;
  reference: string;
}): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: reference,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": product,
    ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`metadata[${key}]`, value])),
    ...(email && { customer_email: email }),
  });
  const response = await fetch(`${api()}/v1/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => null)) as { id?: unknown; url?: unknown; error?: { message?: string } } | null;
  if (!response.ok || typeof json?.id !== "string" || typeof json.url !== "string") {
    throw new Error(`Stripe Checkout failed (${response.status}): ${json?.error?.message ?? "no session"}`);
  }
  return { id: json.id, url: json.url };
}

/** Stripe's tolerance for a webhook's timestamp: older ones are replays. */
const TOLERANCE_SECONDS = 300;

/**
 * Whether `body` is what Stripe signed (the `Stripe-Signature` header: `t=…,v1=…`, an HMAC-SHA256 of
 * "t.body" with the webhook's secret) within the last 5 minutes. Only v1 signatures count.
 */
export function stripeSigned(body: string, header: string | null, secret: string, now = Date.now()): boolean {
  const parts = (header ?? "").split(",").map((part) => part.split("=", 2) as [string, string | undefined]);
  const t = Number(parts.find(([key]) => key === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return parts.some(([key, value]) => {
    if (key !== "v1" || !value || !/^[0-9a-f]{64}$/.test(value)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(value, "hex"), expected);
  });
}
