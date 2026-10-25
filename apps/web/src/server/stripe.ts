import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe, for AI credit top-ups and plans (docs/plan.md, AI usage per project and Plans): Checkout
 * Sessions to pay, the customer portal, reading subscriptions and invoices, and webhooks' signatures.
 * A handful of requests to Stripe's API, so no SDK.
 */

const api = () => (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");

/** The API version every request asks for, so what's read below has the shape it expects whatever the account's default. */
const STRIPE_VERSION = "2025-03-31.basil";

/** Stripe refused a request: its HTTP status (402 for a card that was declined) and its message. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** A request to Stripe's API (form-encoded, like Stripe's); its JSON answer. Throws on any failure (a StripeError when Stripe answered). */
async function stripe<T>(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<T> {
  const response = await fetch(`${api()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: form && new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok || !json) {
    throw new StripeError(response.status, `Stripe ${method} ${path} failed (${response.status}): ${json?.error?.message ?? "no answer"}`);
  }
  return json as T;
}

const metadataFields = (metadata: Record<string, string>, prefix = "metadata") =>
  Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`${prefix}[${key}]`, value]));

/** A Checkout Session's id and payment page; throws unless Stripe gave both. */
async function checkout(form: Record<string, string>): Promise<{ id: string; url: string }> {
  const session = await stripe<{ id?: unknown; url?: unknown }>("POST", "/v1/checkout/sessions", form);
  if (typeof session.id !== "string" || typeof session.url !== "string") {
    throw new Error("Stripe Checkout gave no session");
  }
  return { id: session.id, url: session.url };
}

/** A one-time payment page for `cents` (USD) on Stripe Checkout; returns its URL. Throws on any failure. */
export function createCheckout({
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
  return checkout({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: reference,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": product,
    ...metadataFields(metadata),
    ...(email && { customer_email: email }),
  });
}

/**
 * A Checkout page to start a subscription to `price` for a project: the subscription carries the
 * project's id in its metadata, which is how Stripe's webhook knows whose plan it is. Billed to the
 * project's customer if it has one already, else Stripe makes one (with `email`).
 */
export function createSubscriptionCheckout({
  price,
  projectId,
  customer,
  email,
  successUrl,
  cancelUrl,
}: {
  price: string;
  projectId: string;
  customer: string | null;
  email: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  return checkout({
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: projectId,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    ...metadataFields({ projectId }),
    ...metadataFields({ projectId }, "subscription_data[metadata]"),
    ...(customer ? { customer } : email ? { customer_email: email } : {}),
  });
}

/** Stripe's customer portal for `customer` (change or cancel the plan, the card, invoices); returns its URL. */
export async function createPortal({ customer, returnUrl }: { customer: string; returnUrl: string }): Promise<string> {
  const session = await stripe<{ url?: unknown }>("POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl });
  if (typeof session.url !== "string") {
    throw new Error("Stripe's customer portal gave no URL");
  }
  return session.url;
}

/**
 * Adds `price` to a subscription, charging what's left of the period at once: a card that's declined
 * fails it (402) and nothing is added.
 */
export const addSubscriptionItem = (subscription: string, price: string) =>
  stripe<{ id: string }>("POST", "/v1/subscription_items", {
    subscription,
    price,
    quantity: "1",
    proration_behavior: "always_invoice",
    payment_behavior: "error_if_incomplete",
  });

/** Removes an item from its subscription; what's left of the period it paid for is credited to the next invoice. */
export const removeSubscriptionItem = (id: string) =>
  stripe<{ deleted?: boolean }>("DELETE", `/v1/subscription_items/${encodeURIComponent(id)}?proration_behavior=create_prorations`);

/** A subscription, as read here (STRIPE_VERSION). */
export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  metadata: Record<string, string>;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  items: { data: { id: string; price: { id: string }; current_period_end: number }[] };
};

/** An invoice, as read here (STRIPE_VERSION): its subscription and, per line, the price and the period it pays for. */
export type StripeInvoice = {
  id: string;
  status: string | null;
  billing_reason: string | null;
  parent: { subscription_details?: { subscription?: string | null } | null } | null;
  lines: { data: { period: { end: number }; pricing: { price_details?: { price?: string | null } | null } | null }[] };
};

/** The subscription as Stripe has it now (not as an event said it was). */
export const getSubscription = (id: string) => stripe<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);

/** The invoice as Stripe has it now. */
export const getInvoice = (id: string) => stripe<StripeInvoice>("GET", `/v1/invoices/${encodeURIComponent(id)}`);

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
