import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_STRIPE_KEY = "sk_test_fake";
export const FAKE_STRIPE_WEBHOOK_SECRET = "whsec_test_fake";

/** A Checkout Session as the fake keeps it: what was asked for, and whether it's paid. */
export type FakeCheckoutSession = {
  id: string;
  mode: string;
  success_url: string;
  cancel_url: string;
  amount_total: number;
  currency: string;
  product: string;
  metadata: Record<string, string>;
  client_reference_id: string | null;
  customer_email: string | null;
  payment_status: "unpaid" | "paid";
  url: string;
};

/** A Stripe-Signature header for `body`, like Stripe's: `t=<seconds>,v1=<HMAC-SHA256 of "t.body">`. */
export function stripeSignature(body: string, secret = FAKE_STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export type StripeFake = {
  url: string;
  /** STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_API_URL for an app that uses this fake. */
  env: Record<string, string>;
  /** Every Checkout Session created, in order. */
  sessions: FakeCheckoutSession[];
  /** A signed event about a session (marked paid for the "paid" ones), as Stripe would post it to the app's webhook. */
  event(sessionId: string, type?: string, paymentStatus?: "paid" | "unpaid"): { body: string; headers: Headers };
  close(): Promise<void>;
};

/**
 * A local stand-in for Stripe Checkout: `POST /v1/checkout/sessions` (form-encoded, like Stripe's API),
 * a payment page at the session's `url` whose "Pay" marks it paid, posts `checkout.session.completed`
 * to `webhookUrl` (signed with FAKE_STRIPE_WEBHOOK_SECRET) and then sends the browser to its success_url.
 */
export async function startStripeFake({ webhookUrl }: { webhookUrl?: string } = {}): Promise<StripeFake> {
  const sessions: FakeCheckoutSession[] = [];

  const event = (sessionId: string, type = "checkout.session.completed", paymentStatus: "paid" | "unpaid" = "paid") => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`No session ${sessionId}`);
    }
    session.payment_status = paymentStatus;
    const body = JSON.stringify({ id: `evt_${randomBytes(8).toString("hex")}`, object: "event", type, data: { object: { object: "checkout.session", ...session } } });
    return { body, headers: new Headers({ "content-type": "application/json", "stripe-signature": stripeSignature(body) }) };
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const path = new URL(req.url ?? "/", "http://fake").pathname;
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        if (req.headers.authorization !== `Bearer ${FAKE_STRIPE_KEY}`) {
          return send(401, { error: { message: "Invalid API Key provided" } });
        }
        const form = new URLSearchParams(raw);
        const field = (name: string) => form.get(name);
        const amount = Number(field("line_items[0][price_data][unit_amount]"));
        if (field("mode") !== "payment" || !field("success_url") || !Number.isInteger(amount) || amount <= 0 || field("line_items[0][quantity]") !== "1") {
          return send(400, { error: { message: "expected a one-time payment of one line item, with a success_url" } });
        }
        const id = `cs_test_${randomBytes(12).toString("hex")}`;
        const session: FakeCheckoutSession = {
          id,
          mode: "payment",
          success_url: field("success_url")!,
          cancel_url: field("cancel_url") ?? "",
          amount_total: amount,
          currency: field("line_items[0][price_data][currency]") ?? "",
          product: field("line_items[0][price_data][product_data][name]") ?? "",
          metadata: Object.fromEntries([...form].flatMap(([key, value]) => (/^metadata\[(.+)\]$/.exec(key) ? [[/^metadata\[(.+)\]$/.exec(key)![1]!, value]] : []))),
          client_reference_id: field("client_reference_id"),
          customer_email: field("customer_email"),
          payment_status: "unpaid",
          url: `${url}/checkout/${id}`,
        };
        sessions.push(session);
        return send(200, { object: "checkout.session", ...session });
      }
      const page = /^\/checkout\/([^/]+)(\/pay)?$/.exec(path);
      const session = page && sessions.find((s) => s.id === page[1]);
      if (session && req.method === "GET" && !page[2]) {
        const dollars = (session.amount_total / 100).toFixed(2);
        return res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><title>Stripe Checkout (fake)</title><h1>${session.product}</h1><p>Pay $${dollars}</p>` +
              `<form method="post" action="/checkout/${session.id}/pay"><button>Pay $${dollars}</button></form><a href="${session.cancel_url}">Back</a>`,
          );
      }
      if (session && req.method === "POST" && page[2]) {
        if (webhookUrl) {
          const { body, headers } = event(session.id);
          await fetch(webhookUrl, { method: "POST", body, headers }).catch(() => undefined);
        }
        return res.writeHead(303, { Location: session.success_url.replace("{CHECKOUT_SESSION_ID}", session.id) }).end();
      }
      send(404, { error: { message: `unexpected ${req.method} ${path}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    env: { STRIPE_SECRET_KEY: FAKE_STRIPE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_STRIPE_WEBHOOK_SECRET, STRIPE_API_URL: url },
    sessions,
    event,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
