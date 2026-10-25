import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_STRIPE_KEY = "sk_test_fake";
export const FAKE_STRIPE_WEBHOOK_SECRET = "whsec_test_fake";

/** The fake's prices for plans and the "Powered by tuti" add-on, by the env var the app reads each from, and how often each bills. */
export const FAKE_STRIPE_PRICES = {
  STRIPE_PRICE_PRO_MONTHLY: { id: "price_fake_pro_monthly", interval: "month", cents: 3900 },
  STRIPE_PRICE_PRO_YEARLY: { id: "price_fake_pro_yearly", interval: "year", cents: 38400 },
  STRIPE_PRICE_BUSINESS_MONTHLY: { id: "price_fake_business_monthly", interval: "month", cents: 9900 },
  STRIPE_PRICE_BUSINESS_YEARLY: { id: "price_fake_business_yearly", interval: "year", cents: 94800 },
  STRIPE_PRICE_BADGE_MONTHLY: { id: "price_fake_badge_monthly", interval: "month", cents: 4900 },
  STRIPE_PRICE_BADGE_YEARLY: { id: "price_fake_badge_yearly", interval: "year", cents: 58800 },
} as const;

/** What a price costs: the fake's own, or 1,000 cents for one made for a test. */
const centsOf = (price: string): number => Object.values(FAKE_STRIPE_PRICES).find((p) => p.id === price)?.cents ?? 1000;

/** How often a price bills: the fake's own, or any other `price_…` monthly (a price made for a test). */
const intervalOf = (price: string) =>
  Object.values(FAKE_STRIPE_PRICES).find((p) => p.id === price)?.interval ?? (price.startsWith("price_") ? "month" : undefined);

/** A Checkout Session as the fake keeps it: what was asked for, and whether it's paid. */
export type FakeCheckoutSession = {
  id: string;
  mode: "payment" | "subscription";
  success_url: string;
  cancel_url: string;
  amount_total: number;
  currency: string;
  product: string;
  /** A subscription's price. */
  price: string | null;
  metadata: Record<string, string>;
  /** What a subscription it starts carries in its metadata (subscription_data[metadata]). */
  subscription_metadata: Record<string, string>;
  client_reference_id: string | null;
  customer: string | null;
  customer_email: string | null;
  subscription: string | null;
  /** The payment once it's paid (a one-time payment's; a subscription's first is its invoice's). */
  payment_intent: string | null;
  payment_status: "unpaid" | "paid";
  url: string;
};

/** A charge (2025-03-31.basil): the payment it's for, its amount, what's refunded, and whether it's disputed. */
export type FakeCharge = { id: string; object: "charge"; amount: number; amount_refunded: number; disputed: boolean; payment_intent: string };

/** A subscription, shaped like Stripe's (API version 2025-03-31.basil): its plan is its first item. */
export type FakeSubscription = {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  metadata: Record<string, string>;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  created: number;
  ended_at: number | null;
  items: { data: { id: string; price: { id: string }; current_period_start: number; current_period_end: number }[] };
};

/** An invoice, shaped like Stripe's (2025-03-31.basil): its subscription, and a line per item paying for a period of its price. */
export type FakeInvoice = {
  id: string;
  object: "invoice";
  customer: string;
  status: string;
  billing_reason: string;
  amount_paid: number;
  status_transitions: { paid_at: number };
  parent: { type: "subscription_details"; subscription_details: { subscription: string; metadata: Record<string, string> } };
  lines: { data: { id: string; period: { start: number; end: number }; pricing: { type: "price_details"; price_details: { price: string } } }[] };
};

/** A signed event, as Stripe would post it to the app's webhook. */
export type FakeStripeEvent = { body: string; headers: Headers };

/** A Stripe-Signature header for `body`, like Stripe's: `t=<seconds>,v1=<HMAC-SHA256 of "t.body">`. */
export function stripeSignature(body: string, secret = FAKE_STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export type StripeFake = {
  url: string;
  /** STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_API_URL and the plans' STRIPE_PRICE_* for an app that uses this fake. */
  env: Record<string, string>;
  /** Every Checkout Session created, in order. */
  sessions: FakeCheckoutSession[];
  subscriptions: Map<string, FakeSubscription>;
  invoices: Map<string, FakeInvoice>;
  /** Every charge, by id. */
  charges: Map<string, FakeCharge>;
  /** The charge that paid a Checkout Session (one-time payments) or an invoice. */
  chargeFor(sessionOrInvoiceId: string): FakeCharge;
  /** Refunds `cents` of a charge (all of what's left without), as the dashboard would: its `charge.refunded` event. */
  refund(chargeId: string, cents?: number): FakeStripeEvent;
  /** A customer disputes a charge: its `charge.dispute.created` event. */
  dispute(chargeId: string): FakeStripeEvent;
  /** Customer portal sessions: each one's customer and where it returns to. */
  portals: { id: string; customer: string; return_url: string; url: string }[];
  /** A signed event about a session (marked paid for the "paid" ones), as Stripe would post it to the app's webhook. */
  event(sessionId: string, type?: string, paymentStatus?: "paid" | "unpaid"): FakeStripeEvent;
  /**
   * Pays a session, as its page's "Pay" does: a payment is marked paid; a subscription starts (a customer
   * if the session had none, the subscription, its first invoice, paid). Returns the events Stripe would send.
   */
  pay(sessionId: string): FakeStripeEvent[];
  /** A subscription's next period, paid: its events. */
  renew(subscriptionId: string): FakeStripeEvent[];
  /** Cards are declined while this is true: adding an item to a subscription fails (402). */
  declining: boolean;
  /** Changes a subscription (its status, its plan's price, or cancelling at the period's end): its event (`.deleted` once canceled). */
  update(subscriptionId: string, changes: { status?: string; price?: string; cancelAtPeriodEnd?: boolean }): FakeStripeEvent;
  close(): Promise<void>;
};

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

/** Unix seconds that only go forward, one at least per call: events a test makes one after another never share a second. */
let lastTick = 0;
const tick = () => (lastTick = Math.max(Math.floor(Date.now() / 1000), lastTick + 1));

/** `seconds` plus one month or year. */
function after(seconds: number, interval: "month" | "year") {
  const date = new Date(seconds * 1000);
  if (interval === "year") {
    date.setUTCFullYear(date.getUTCFullYear() + 1);
  } else {
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return Math.floor(date.getTime() / 1000);
}

/**
 * A local stand-in for Stripe: Checkout (`POST /v1/checkout/sessions`, form-encoded like Stripe's API) for
 * one-time payments and subscriptions, a payment page at the session's `url` whose "Pay" posts the events
 * Stripe would to `webhookUrl` (signed with FAKE_STRIPE_WEBHOOK_SECRET) and then sends the browser to its
 * success_url; reading subscriptions and invoices; and the customer portal, whose page can cancel a plan.
 */
export async function startStripeFake({ webhookUrl }: { webhookUrl?: string } = {}): Promise<StripeFake> {
  const sessions: FakeCheckoutSession[] = [];
  const subscriptions = new Map<string, FakeSubscription>();
  const invoices = new Map<string, FakeInvoice>();
  const portals: StripeFake["portals"] = [];
  const charges = new Map<string, FakeCharge>();
  /** Which Checkout Session or invoice each payment intent paid. */
  const paid = new Map<string, { session?: string; invoice?: string }>();

  /** A payment of `amount` for a session or an invoice: its payment intent and charge. */
  const charge = (amount: number, paidFor: { session?: string; invoice?: string }) => {
    const intent = id("pi");
    const made: FakeCharge = { id: id("ch"), object: "charge", amount, amount_refunded: 0, disputed: false, payment_intent: intent };
    charges.set(made.id, made);
    paid.set(intent, paidFor);
    return intent;
  };

  const signed = (type: string, object: object): FakeStripeEvent => {
    const body = JSON.stringify({ id: id("evt"), object: "event", type, data: { object } });
    return { body, headers: new Headers({ "content-type": "application/json", "stripe-signature": stripeSignature(body) }) };
  };

  const event = (sessionId: string, type = "checkout.session.completed", paymentStatus: "paid" | "unpaid" = "paid") => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`No session ${sessionId}`);
    }
    session.payment_status = paymentStatus;
    return signed(type, { object: "checkout.session", ...session });
  };

  const subscription = (subscriptionId: string) => {
    const found = subscriptions.get(subscriptionId);
    if (!found) {
      throw new Error(`No subscription ${subscriptionId}`);
    }
    return found;
  };

  /** A paid invoice for the subscription's current period. */
  const invoice = (sub: FakeSubscription, billingReason: string) => {
    const paidInvoice: FakeInvoice = {
      id: id("in"),
      object: "invoice",
      customer: sub.customer,
      status: "paid",
      billing_reason: billingReason,
      amount_paid: sub.items.data.reduce((sum, each) => sum + centsOf(each.price.id), 0),
      status_transitions: { paid_at: tick() },
      parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
      lines: {
        data: sub.items.data.map((each) => ({
          id: id("il"),
          period: { start: each.current_period_start, end: each.current_period_end },
          pricing: { type: "price_details" as const, price_details: { price: each.price.id } },
        })),
      },
    };
    invoices.set(paidInvoice.id, paidInvoice);
    charge(paidInvoice.amount_paid, { invoice: paidInvoice.id });
    return signed("invoice.paid", paidInvoice);
  };

  const pay = (sessionId: string): FakeStripeEvent[] => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`No session ${sessionId}`);
    }
    if (session.mode === "payment") {
      session.payment_intent ??= charge(session.amount_total, { session: session.id });
      return [event(session.id)];
    }
    const now = Math.floor(Date.now() / 1000);
    const sub: FakeSubscription = {
      id: id("sub"),
      object: "subscription",
      customer: session.customer ?? id("cus"),
      status: "active",
      metadata: session.subscription_metadata,
      cancel_at_period_end: false,
      cancel_at: null,
      created: tick(),
      ended_at: null,
      items: { data: [{ id: id("si"), price: { id: session.price! }, current_period_start: now, current_period_end: after(now, intervalOf(session.price!)!) }] },
    };
    subscriptions.set(sub.id, sub);
    Object.assign(session, { customer: sub.customer, subscription: sub.id });
    return [event(session.id), signed("customer.subscription.created", sub), invoice(sub, "subscription_create")];
  };

  const renew = (subscriptionId: string) => {
    const sub = subscription(subscriptionId);
    for (const item of sub.items.data) {
      item.current_period_start = item.current_period_end;
      item.current_period_end = after(item.current_period_end, intervalOf(item.price.id)!);
    }
    return [signed("customer.subscription.updated", sub), invoice(sub, "subscription_cycle")];
  };

  const update = (subscriptionId: string, changes: { status?: string; price?: string; cancelAtPeriodEnd?: boolean }) => {
    const sub = subscription(subscriptionId);
    const item = sub.items.data[0]!;
    if (changes.status) {
      sub.status = changes.status;
      sub.ended_at = changes.status === "canceled" ? tick() : null;
    }
    if (changes.price) {
      item.price = { id: changes.price };
    }
    if (changes.cancelAtPeriodEnd !== undefined) {
      sub.cancel_at_period_end = changes.cancelAtPeriodEnd;
      sub.cancel_at = changes.cancelAtPeriodEnd ? item.current_period_end : null;
    }
    return signed(sub.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated", sub);
  };

  /** Events an API call causes, sent after it answers, as Stripe's are (the caller may hold locks its webhook needs). */
  const sendLater = (events: FakeStripeEvent[]) => void setTimeout(() => void post(events), 0);

  const post = async (events: FakeStripeEvent[]) => {
    for (const { body, headers } of webhookUrl ? events : []) {
      await fetch(webhookUrl!, { method: "POST", body, headers }).catch(() => undefined);
    }
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const html = (body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>${body}`);
      const path = new URL(req.url ?? "/", "http://fake").pathname;
      if (path.startsWith("/v1/") && req.headers.authorization !== `Bearer ${FAKE_STRIPE_KEY}`) {
        return send(401, { error: { message: "Invalid API Key provided" } });
      }
      const form = new URLSearchParams(raw);
      const field = (name: string) => form.get(name);
      const fields = (prefix: string) =>
        Object.fromEntries([...form].flatMap(([key, value]) => (key.startsWith(`${prefix}[`) && key.endsWith("]") ? [[key.slice(prefix.length + 1, -1), value]] : [])));

      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        const mode = field("mode");
        const amount = Number(field("line_items[0][price_data][unit_amount]"));
        const price = field("line_items[0][price]");
        const valid =
          field("success_url") &&
          field("line_items[0][quantity]") === "1" &&
          ((mode === "payment" && Number.isInteger(amount) && amount > 0) || (mode === "subscription" && price && intervalOf(price)));
        if (!valid) {
          return send(400, { error: { message: "expected a one-time payment or a subscription to a known price, of one line item, with a success_url" } });
        }
        const sessionId = id("cs_test");
        const session: FakeCheckoutSession = {
          id: sessionId,
          mode: mode as "payment" | "subscription",
          success_url: field("success_url")!,
          cancel_url: field("cancel_url") ?? "",
          amount_total: mode === "payment" ? amount : 0,
          currency: field("line_items[0][price_data][currency]") ?? "usd",
          product: field("line_items[0][price_data][product_data][name]") ?? price ?? "",
          price,
          metadata: fields("metadata"),
          subscription_metadata: fields("subscription_data[metadata]"),
          client_reference_id: field("client_reference_id"),
          customer: field("customer"),
          customer_email: field("customer_email"),
          subscription: null,
          payment_intent: null,
          payment_status: "unpaid",
          url: `${url}/checkout/${sessionId}`,
        };
        sessions.push(session);
        return send(200, { object: "checkout.session", ...session });
      }
      const params = new URL(req.url ?? "/", "http://fake").searchParams;
      if (req.method === "GET" && path === "/v1/checkout/sessions") {
        return send(200, { object: "list", data: sessions.filter((s) => s.payment_intent && s.payment_intent === params.get("payment_intent")) });
      }
      if (req.method === "GET" && path === "/v1/invoice_payments") {
        const invoice = params.get("payment[type]") === "payment_intent" ? paid.get(params.get("payment[payment_intent]") ?? "")?.invoice : undefined;
        return send(200, { object: "list", data: invoice ? [{ object: "invoice_payment", invoice }] : [] });
      }
      const sessionRead = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
      if (req.method === "GET" && sessionRead) {
        const found = sessions.find((s) => s.id === sessionRead[1]);
        return found ? send(200, { object: "checkout.session", ...found }) : send(404, { error: { message: `No such checkout.session: '${sessionRead[1]}'` } });
      }
      const chargeRead = /^\/v1\/charges\/([^/]+)$/.exec(path);
      if (req.method === "GET" && chargeRead) {
        const found = charges.get(chargeRead[1]!);
        return found ? send(200, found) : send(404, { error: { message: `No such charge: '${chargeRead[1]}'` } });
      }
      const cancelling = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && cancelling) {
        const sub = subscriptions.get(cancelling[1]!);
        if (!sub || sub.status === "canceled") {
          return send(sub ? 400 : 404, { error: { message: sub ? "This subscription is already canceled" : `No such subscription: '${cancelling[1]}'` } });
        }
        sendLater([update(sub.id, { status: "canceled" })]);
        return send(200, sub);
      }
      const read = /^\/v1\/(subscriptions|invoices)\/([^/]+)$/.exec(path);
      if (req.method === "GET" && read) {
        const found = (read[1] === "subscriptions" ? subscriptions : invoices).get(decodeURIComponent(read[2]!));
        return found ? send(200, found) : send(404, { error: { message: `No such ${read[1]!.slice(0, -1)}: '${read[2]}'` } });
      }
      if (req.method === "POST" && path === "/v1/subscription_items") {
        const sub = subscriptions.get(field("subscription") ?? "");
        const price = field("price");
        const item = sub?.items.data[0];
        if (!sub || !item || !price || intervalOf(price) !== intervalOf(item.price.id) || field("quantity") !== "1") {
          return send(400, { error: { message: "expected a subscription, and one of a known price billed like it" } });
        }
        if (fake.declining) {
          return send(402, { error: { type: "card_error", message: "Your card was declined." } });
        }
        const added = { id: id("si"), price: { id: price }, current_period_start: item.current_period_start, current_period_end: item.current_period_end };
        sub.items.data.push(added);
        // Charged at once (always_invoice): an invoice for what's left of the period, paid.
        const proration: FakeInvoice = {
          id: id("in"),
          object: "invoice",
          customer: sub.customer,
          status: "paid",
          billing_reason: "subscription_update",
          amount_paid: centsOf(price),
          status_transitions: { paid_at: tick() },
          parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
          lines: { data: [{ id: id("il"), period: { start: item.current_period_start, end: item.current_period_end }, pricing: { type: "price_details", price_details: { price } } }] },
        };
        invoices.set(proration.id, proration);
        charge(proration.amount_paid, { invoice: proration.id });
        sendLater([signed("customer.subscription.updated", sub), signed("invoice.paid", proration)]);
        return send(200, { object: "subscription_item", ...added });
      }
      const removing = /^\/v1\/subscription_items\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && removing) {
        const sub = [...subscriptions.values()].find((s) => s.items.data.some((item) => item.id === removing[1]));
        if (!sub) {
          return send(404, { error: { message: `No such subscription item: '${removing[1]}'` } });
        }
        sub.items.data = sub.items.data.filter((item) => item.id !== removing[1]);
        sendLater([signed("customer.subscription.updated", sub)]);
        return send(200, { id: removing[1], object: "subscription_item", deleted: true });
      }
      if (req.method === "POST" && path === "/v1/billing_portal/sessions") {
        if (!field("customer") || !field("return_url")) {
          return send(400, { error: { message: "expected a customer and a return_url" } });
        }
        const portalId = id("bps");
        const portal = { id: portalId, customer: field("customer")!, return_url: field("return_url")!, url: `${url}/portal/${portalId}` };
        portals.push(portal);
        return send(200, { object: "billing_portal.session", ...portal });
      }

      const page = /^\/checkout\/([^/]+)(\/pay)?$/.exec(path);
      const session = page && sessions.find((s) => s.id === page[1]);
      if (session && req.method === "GET" && !page[2]) {
        const action = session.mode === "payment" ? `Pay $${(session.amount_total / 100).toFixed(2)}` : "Subscribe";
        return html(
          `<title>Stripe Checkout (fake)</title><h1>${session.product}</h1><p>${action}</p>` +
            `<form method="post" action="/checkout/${session.id}/pay"><button>${action}</button></form><a href="${session.cancel_url}">Back</a>`,
        );
      }
      if (session && req.method === "POST" && page[2]) {
        await post(pay(session.id));
        return res.writeHead(303, { Location: session.success_url.replace("{CHECKOUT_SESSION_ID}", session.id) }).end();
      }

      const portalPage = /^\/portal\/([^/]+)(?:\/cancel\/([^/]+))?$/.exec(path);
      const portal = portalPage && portals.find((p) => p.id === portalPage[1]);
      if (portal && req.method === "GET") {
        const live = [...subscriptions.values()].filter((s) => s.customer === portal.customer && s.status !== "canceled");
        return html(
          `<title>Stripe customer portal (fake)</title><h1>Your plan</h1>` +
            live
              .map(
                (s) =>
                  `<p>${s.items.data[0]!.price.id}${s.cancel_at_period_end ? " (cancelled)" : ""}</p>` +
                  (s.cancel_at_period_end ? "" : `<form method="post" action="/portal/${portal.id}/cancel/${s.id}"><button>Cancel plan</button></form>`),
              )
              .join("") +
            `<a href="${portal.return_url}">Return to Tuti</a>`,
        );
      }
      if (portal && req.method === "POST" && portalPage[2] && subscriptions.get(portalPage[2])?.customer === portal.customer) {
        await post([update(portalPage[2], { cancelAtPeriodEnd: true })]);
        return res.writeHead(303, { Location: `/portal/${portal.id}` }).end();
      }
      send(404, { error: { message: `unexpected ${req.method} ${path}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: StripeFake = {
    url,
    declining: false,
    env: {
      STRIPE_SECRET_KEY: FAKE_STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_STRIPE_WEBHOOK_SECRET,
      STRIPE_API_URL: url,
      ...Object.fromEntries(Object.entries(FAKE_STRIPE_PRICES).map(([name, price]) => [name, price.id])),
    },
    sessions,
    subscriptions,
    invoices,
    portals,
    event,
    charges,
    chargeFor: (sessionOrInvoiceId: string) => {
      const intent = [...paid].find(([, paidFor]) => paidFor.session === sessionOrInvoiceId || paidFor.invoice === sessionOrInvoiceId)?.[0];
      const found = [...charges.values()].find((c) => c.payment_intent === intent);
      if (!found) {
        throw new Error(`No charge for ${sessionOrInvoiceId}`);
      }
      return found;
    },
    refund: (chargeId: string, cents?: number) => {
      const found = charges.get(chargeId)!;
      found.amount_refunded = Math.min(found.amount, found.amount_refunded + (cents ?? found.amount - found.amount_refunded));
      return signed("charge.refunded", found);
    },
    dispute: (chargeId: string) => {
      const found = charges.get(chargeId)!;
      found.disputed = true;
      return signed("charge.dispute.created", { id: id("dp"), object: "dispute", charge: found.id, amount: found.amount, status: "needs_response" });
    },
    pay,
    renew,
    update,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
