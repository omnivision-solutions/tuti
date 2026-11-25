import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventReader, type LiveUpdate, openLive, POLL_MS, updateOf } from "./live";

const session = { server: "https://tuti.example.com", token: "token-1", project: "acme" };

describe("reading the stream", () => {
  it("reads events across chunks, skips comments, and takes the retry", () => {
    const events: [string, string][] = [];
    const retries: number[] = [];
    const read = eventReader(
      (event, data) => events.push([event, data]),
      (ms) => retries.push(ms),
    );
    read("retry: 3000\n\nevent: ready\ndata: {}\n\n: ping\n\nevent: cha");
    read('nge\ndata: {"conversation":12}\r\n\r\n');
    expect(events).toEqual([
      ["ready", "{}"],
      ["change", '{"conversation":12}'],
    ]);
    expect(retries).toEqual([3000]);
  });

  it("turns events into what the screen fetches", () => {
    expect(updateOf("ready", "{}")).toEqual({ kind: "all" });
    expect(updateOf("change", '{"conversation":12}')).toEqual({ kind: "conversation", number: 12 });
    expect(updateOf("change", "{}")).toEqual({ kind: "all" });
    expect(updateOf("change", "not json")).toEqual({ kind: "all" });
    expect(updateOf("message", "{}")).toBeNull();
  });
});

/** A stream the test writes to. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return { body, write: (text: string) => controller.enqueue(encoder.encode(text)), end: () => controller.close() };
}

describe("openLive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens with the session's headers and passes on its events", async () => {
    const live = stream();
    const fetchFn = vi.fn(async () => new Response(live.body, { status: 200 }));
    const updates: LiveUpdate[] = [];
    const close = openLive(session, (update) => updates.push(update), fetchFn as unknown as typeof fetch);

    live.write('event: ready\ndata: {}\n\nevent: change\ndata: {"conversation":7}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([{ kind: "all" }, { kind: "conversation", number: 7 }]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tuti.example.com/api/live");
    expect(init.headers).toMatchObject({ authorization: "Bearer token-1", "tuti-project": "acme" });
    close();
  });

  it("reconnects when it drops, fetching everything every 10 seconds until it's back", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const updates: LiveUpdate[] = [];
    const close = openLive(session, (update) => updates.push(update), fetchFn as unknown as typeof fetch);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(2);
    expect(updates).toEqual([{ kind: "all" }]);

    // Back: the stream's `ready` fetches everything once more, and the polling stops.
    const live = stream();
    fetchFn.mockImplementation(async () => new Response(live.body, { status: 200 }) as never);
    await vi.advanceTimersByTimeAsync(3_000);
    live.write("event: ready\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    const before = updates.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(updates.length).toBe(before);
    close();
  });

  it("stops for good when the server refuses it, asking for everything once", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 }));
    const updates: LiveUpdate[] = [];
    openLive(session, (update) => updates.push(update), fetchFn as unknown as typeof fetch);

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ kind: "all" }]);
  });

  it("does nothing more once closed", async () => {
    const live = stream();
    const updates: LiveUpdate[] = [];
    const close = openLive(session, (update) => updates.push(update), (async () => new Response(live.body)) as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    close();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(updates).toEqual([]);
  });
});
