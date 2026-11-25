import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** A message as the server sends it to Expo's push service. */
export type ExpoPushMessage = { to: string; title?: string; body?: string; data?: Record<string, unknown>; [field: string]: unknown };
type Outcome = { status: "ok"; id?: string } | { status: "error"; message: string; details: { error: string } };

export type ExpoPushFake = {
  /** For EXPO_PUSH_URL. */
  env: { EXPO_PUSH_URL: string };
  /** Every message sent, in order, with the headers of its request. */
  sent: (ExpoPushMessage & { ticket: string | null; headers: IncomingHttpHeaders })[];
  /** Tokens Expo answers DeviceNotRegistered for when they're sent to. */
  unregistered: Set<string>;
  /** Receipts by ticket id, for getReceipts (a ticket left out has none yet). */
  receipts: Record<string, Outcome>;
  /** The ids each getReceipts asked about. */
  asked: string[][];
  /** The Expo project a token belongs to (`@owner/slug`); any not here are `@tuti/app`. A send mixing projects is refused. */
  projects: Map<string, string>;
  /** Projects whose sends fail with a 500 (a request of one project's tokens only). */
  failing: Set<string>;
  /** Which /send requests fail with a 500, counted from 1 since the fake started or `sends` was last set to 0. */
  failSends: Set<number>;
  /** How many /send requests have come in. */
  sends: number;
  /** The status to answer every request with instead (e.g. 500), or 200. */
  status: number;
  close(): Promise<void>;
};

/** The error Expo's service gives for a token that's no longer registered. */
export const deviceNotRegistered = (token: string): Outcome => ({
  status: "error",
  message: `"${token}" is not a registered push notification recipient`,
  details: { error: "DeviceNotRegistered" },
});

/**
 * A local stand-in for Expo's push service (https://exp.host/--/api/v2/push): `/send` (an array of up to 100 messages,
 * a ticket each in order) and `/getReceipts` (`{ ids }`), as its docs describe them.
 */
export async function startExpoPushFake(): Promise<ExpoPushFake> {
  let tickets = 0;
  const fake: ExpoPushFake = { env: { EXPO_PUSH_URL: "" }, sent: [], unregistered: new Set(), receipts: {}, asked: [], projects: new Map(), failing: new Set(), failSends: new Set(), sends: 0, status: 200, close: async () => {} };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const answer = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (fake.status !== 200) {
        return answer(fake.status, { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "The fake was told to fail" }] });
      }
      const body = JSON.parse(raw) as unknown;
      if (req.url === "/send") {
        if (fake.failSends.has(++fake.sends)) {
          return answer(500, { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "The fake was told to fail this request" }] });
        }
        const messages = (Array.isArray(body) ? body : [body]) as ExpoPushMessage[];
        if (messages.length > 100) {
          return answer(400, { errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS", message: "Up to 100 a request" }] });
        }
        // As Expo does: one project a request, the tokens grouped by project in the error's details otherwise.
        const byProject: Record<string, string[]> = {};
        for (const message of messages) {
          (byProject[fake.projects.get(message.to) ?? "@tuti/app"] ??= []).push(message.to);
        }
        if (Object.keys(byProject).length > 1) {
          return answer(400, {
            errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "All push notification messages in the same request must be for the same project", details: byProject }],
          });
        }
        if (fake.failing.has(Object.keys(byProject)[0] ?? "")) {
          return answer(500, { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "The fake was told to fail this project" }] });
        }
        const data = messages.map((message): Outcome => {
          const ticket = fake.unregistered.has(message.to) ? null : `ticket-${++tickets}`;
          fake.sent.push({ ...message, ticket, headers: req.headers });
          return ticket ? { status: "ok", id: ticket } : deviceNotRegistered(message.to);
        });
        return answer(200, { data });
      }
      if (req.url === "/getReceipts") {
        const { ids } = body as { ids: string[] };
        fake.asked.push(ids);
        return answer(200, { data: Object.fromEntries(ids.flatMap((id) => (fake.receipts[id] ? [[id, fake.receipts[id]]] : []))) });
      }
      answer(404, { errors: [{ code: "NOT_FOUND", message: "No such endpoint" }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.env.EXPO_PUSH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return fake;
}
