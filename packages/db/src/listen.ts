import pg from "pg";

/**
 * Listens on a Postgres NOTIFY channel with its own connection (Prisma's pool can't hold one open).
 * `onListening` runs each time the connection starts listening, the first time too: notifications
 * before then (since the caller last read, or during a drop) were lost, so listeners should catch up. Returns a function that stops listening.
 */
export function listen(
  channel: string,
  { onPayload, onListening }: { onPayload: (payload: string) => void; onListening: () => void },
): () => Promise<void> {
  let client: pg.Client | null = null;
  let stopped = false;

  const connect = async () => {
    const next = new pg.Client({ connectionString: process.env.DATABASE_URL });
    next.on("notification", (message) => {
      if (message.channel === channel && message.payload) {
        onPayload(message.payload);
      }
    });
    const retry = () => {
      if (stopped || client !== next) {
        return;
      }
      client = null;
      next.end().catch(() => {});
      setTimeout(() => void connect(), 1000).unref?.();
    };
    next.on("error", retry);
    next.on("end", retry);
    client = next;
    try {
      await next.connect();
      // The channel is ours, a constant: quoted as an identifier.
      await next.query(`LISTEN "${channel.replace(/"/g, '""')}"`);
      onListening();
    } catch {
      retry();
    }
  };
  void connect();

  return async () => {
    stopped = true;
    await client?.end().catch(() => {});
  };
}
