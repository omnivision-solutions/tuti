import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export type WebhookReceiver = {
  /** Where to send webhooks (on 127.0.0.1; set WEBHOOK_ALLOW_PRIVATE_URLS=true). */
  url: string;
  /** Requests received, in order. */
  received: { headers: IncomingHttpHeaders; body: string }[];
  /** The status to answer with (default 200; 3xx answers redirect elsewhere). */
  status: number;
  close(): Promise<void>;
};

/** A local stand-in for a customer's webhook endpoint. */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const receiver: WebhookReceiver = { url: "", received: [], status: 200, close: async () => {} };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receiver.received.push({ headers: req.headers, body });
      const redirect = receiver.status >= 300 && receiver.status < 400 ? { location: "http://127.0.0.1:1/" } : {};
      res.writeHead(receiver.status, redirect).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  receiver.close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return receiver;
}
