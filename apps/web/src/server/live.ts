import { listen, type Prisma, prisma } from "@tuti/db";

/**
 * Live updates for the support inbox (docs/plan.md, Support inbox, "Live"): a change commits with a
 * Postgres NOTIFY naming the project, the conversation and whose it is, never its content. Each app
 * instance keeps one LISTEN connection and passes each change only to the streams allowed to see it;
 * a stream's client then fetches what changed through the usual actions, so access is checked in
 * one place. NOTIFY reaches only those already listening, so a stream that (re)opens fetches anew.
 */

const CHANNEL = "tuti_inbox";

export type InboxChange = {
  projectId: string;
  conversationId: string;
  /** Whose conversation: someone Tuti knows, or a signed-out visitor (their token's hash). */
  userId: string | null;
  visitorHash: string | null;
};

/** Tells live streams about a change, in the transaction that makes it (sent only once it commits). */
export async function notifyInbox(tx: Prisma.TransactionClient, change: InboxChange) {
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(change)})`;
}

/** Tells live streams now, outside any transaction (someone came online: nothing to commit). */
export async function notifyInboxNow(change: InboxChange) {
  await prisma.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(change)})`;
}

type Subscriber = { wants: (change: InboxChange) => boolean; changed: () => void };

// One listener and one set of streams per instance (kept across hot reloads in dev).
const state = globalThis as unknown as { tutiInbox?: { subscribers: Set<Subscriber>; stop: (() => Promise<void>) | null } };
const inbox = (state.tutiInbox ??= { subscribers: new Set(), stop: null });

function received(payload: string) {
  let change: InboxChange;
  try {
    change = JSON.parse(payload) as InboxChange;
  } catch {
    return;
  }
  for (const subscriber of inbox.subscribers) {
    if (subscriber.wants(change)) {
      subscriber.changed();
    }
  }
}

/**
 * Calls `changed` for every change `wants` lets through, until the returned function is called.
 * After the listener's connection drops and comes back, every stream hears of "a change", since
 * what changed meanwhile is unknown.
 */
export function subscribeInbox(wants: Subscriber["wants"], changed: Subscriber["changed"]): () => void {
  const subscriber = { wants, changed };
  inbox.subscribers.add(subscriber);
  inbox.stop ??= listen(CHANNEL, {
    onPayload: received,
    onReconnect: () => inbox.subscribers.forEach((s) => s.changed()),
  });
  return () => {
    inbox.subscribers.delete(subscriber);
  };
}

/** Comments that keep proxies (Cloudflare closes idle connections after 100 seconds) from dropping a stream. */
export const KEEPALIVE_MS = 25_000;

/**
 * A Server-Sent Events response: `ready` once open (fetch the current state), `change` when there's
 * something new, and a comment every KEEPALIVE_MS, when `stillAllowed` is checked again (the stream
 * ends once it's false: signed out, token expired, taken off the team). Ends when the client goes.
 */
export function inboxStream(
  request: Request,
  {
    wants,
    stillAllowed,
    headers = {},
  }: { wants: Subscriber["wants"]; stillAllowed: () => Promise<boolean>; headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (open) {
          controller.enqueue(encoder.encode(text));
        }
      };
      const unsubscribe = subscribeInbox(wants, () => send("event: change\ndata: {}\n\n"));
      const timer = setInterval(() => {
        void stillAllowed().then(
          (allowed) => (allowed ? send(": ping\n\n") : cleanup()),
          () => send(": ping\n\n"),
        );
      }, KEEPALIVE_MS);
      cleanup = () => {
        if (!open) {
          return;
        }
        open = false;
        clearInterval(timer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already cancelled by the client.
        }
      };
      request.signal.addEventListener("abort", cleanup);
      send("retry: 3000\nevent: ready\ndata: {}\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      // Proxies that buffer (nginx) pass it straight through.
      "x-accel-buffering": "no",
      ...headers,
    },
  });
}
