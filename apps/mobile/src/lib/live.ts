/**
 * The project's live updates while the Inbox is open: `/api/live`, a Server-Sent Events stream with the session's
 * headers (apps/web/src/lib/app-sign-in.ts has the contract). React Native has no EventSource; Expo's fetch (the global
 * `fetch` in the app) streams the body, read here line by line.
 */

/** What the screen does: `all` fetch everything shown (the stream opened, a bare change, or a poll while it's down); `conversation` that one. */
export type LiveUpdate = { kind: "all" } | { kind: "conversation"; number: number };

/** How often everything is fetched while the stream keeps failing, and how long before it's tried again (its `retry:`). */
export const POLL_MS = 10_000;
const RETRY_MS = 3_000;

/** Reads a stream's text as it comes: each event's name and data, and its `retry:`. */
export function eventReader(onEvent: (event: string, data: string) => void, onRetry: (ms: number) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  return (text: string) => {
    buffer += text;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line === "") {
        if (data.length || event) {
          onEvent(event || "message", data.join("\n"));
        }
        event = "";
        data = [];
        continue;
      }
      const colon = line.indexOf(":");
      // A comment (`: ping`).
      if (colon === 0) {
        continue;
      }
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        data.push(value);
      } else if (field === "retry" && /^\d+$/.test(value)) {
        onRetry(Number(value));
      }
    }
  };
}

/** An event as the screen acts on it; nothing for one it doesn't know. */
export function updateOf(event: string, data: string): LiveUpdate | null {
  if (event === "ready") {
    return { kind: "all" };
  }
  if (event !== "change") {
    return null;
  }
  try {
    const number = (JSON.parse(data) as { conversation?: unknown } | null)?.conversation;
    return typeof number === "number" ? { kind: "conversation", number } : { kind: "all" };
  } catch {
    return { kind: "all" };
  }
}

type Session = { server: string; token: string; project?: string };

/**
 * Opens the stream and keeps it open: reconnecting after its `retry:` when it drops, and fetching everything every
 * POLL_MS while it's down. Refused for good (401, 403, 400: signed out, off the team), it stops and asks for everything
 * once, so the screen's own fetch says why. Returns the function that closes it.
 */
export function openLive(session: Session, onUpdate: (update: LiveUpdate) => void, fetchFn: typeof fetch = fetch, timers = { setTimeout, clearTimeout, setInterval, clearInterval }) {
  let closed = false;
  let controller: AbortController | null = null;
  let retry = RETRY_MS;
  let again: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;

  const down = () => {
    if (closed) {
      return;
    }
    polling ??= timers.setInterval(() => onUpdate({ kind: "all" }), POLL_MS);
    again = timers.setTimeout(connect, retry);
  };

  async function connect() {
    controller = new AbortController();
    try {
      const response = await fetchFn(`${session.server}/api/live`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${session.token}`, ...(session.project ? { "tuti-project": session.project } : {}) },
        credentials: "omit",
        signal: controller.signal,
      });
      if ([400, 401, 403].includes(response.status)) {
        stop();
        onUpdate({ kind: "all" });
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`live ${response.status}`);
      }
      const read = eventReader(
        (event, data) => {
          if (event === "ready" && polling !== undefined) {
            timers.clearInterval(polling);
            polling = undefined;
          }
          const update = updateOf(event, data);
          if (update && !closed) {
            onUpdate(update);
          }
        },
        (ms) => (retry = ms),
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        read(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Dropped or unreachable: as when it ends.
    }
    down();
  }

  function stop() {
    closed = true;
    controller?.abort();
    timers.clearTimeout(again);
    timers.clearInterval(polling);
  }

  void connect();
  return stop;
}
