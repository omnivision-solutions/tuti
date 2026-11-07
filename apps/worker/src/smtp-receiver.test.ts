import { createHash } from "node:crypto";
import { connect } from "node:net";

import { inboundSignatureValid } from "@tuti/shared/inbound-signature";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import { afterEach, expect, test, vi } from "vitest";

import {
  ARRIVAL_TIMEOUT_MS,
  AUTH_TIMEOUT_MS,
  checkAuth,
  IDLE_TIMEOUT_MS,
  LOOKUP_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  MAX_CLIENTS,
  MAX_DKIM_SIGNATURES,
  MAX_HEADER_BYTES,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_PER_SOURCE,
  MAX_PER_SOURCE,
  receiverFromEnv,
  sourceOf,
  startSmtpReceiver,
} from "./smtp-receiver";

const SECRET = "a-test-secret-of-at-least-32-characters";

/** DNS for the checks, offline: example.org's mail comes from here (127.0.0.1); forged.example's doesn't. */
const records: Record<string, string[][]> = {
  "TXT example.org": [["v=spf1 ip4:127.0.0.1 -all"]],
  "TXT _dmarc.example.org": [["v=DMARC1; p=reject"]],
  "TXT forged.example": [["v=spf1 ip4:192.0.2.1 -all"]],
  "TXT _dmarc.forged.example": [["v=DMARC1; p=reject"]],
};
const resolver = async (name: string, type: string) => {
  const found = records[`${type} ${name.toLowerCase()}`];
  if (!found) {
    throw Object.assign(new Error(`${name} not found`), { code: "ENOTFOUND" });
  }
  return found;
};

let server: SMTPServer | undefined;
afterEach(() => {
  vi.useRealTimers();
  const closing = server;
  server = undefined;
  return new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
});

/**
 * The receiver's clock, faked: time moves only when a test moves it. Its timeouts (idle, a message's
 * arrival, the lifetime) are a clock its reaper reads on an interval; smtp-server's own timers stay real.
 */
const fakeSessionClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

/** The checks' timers, faked: their deadlines are timeouts. */
const fakeCheckTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

/** Moves fake time on by `ms`, a second at a time, letting the real work in between (streams, I/O) catch up: timers set during a step can fire up to a second late, so callers add a second. */
async function elapse(ms: number) {
  for (let passed = 0; passed < ms; passed += 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(1_000, ms - passed));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A receiver for support.test, posting to a fake app that answers `answers` in turn (then 200). */
type Limits = {
  maxBytes?: number;
  maxRecipients?: number;
  maxPerSource?: number;
  maxInFlight?: number;
  maxBufferedBytes?: number;
  sessionLifetimeMs?: number;
  resolver?: (name: string, type: string) => Promise<unknown>;
};

async function receiver(
  answers: { status: number; outcome?: string }[] = [],
  limits: Limits = {},
  post?: (url: string, request: { body: Buffer; headers: Record<string, string> }) => Promise<{ status: number; outcome?: string }>,
) {
  const posts: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
  server = await startSmtpReceiver({
    domain: "support.test",
    appUrl: "https://app.example.com",
    secret: SECRET,
    port: 0,
    host: "127.0.0.1",
    serverName: "mx.support.test",
    resolver,
    ...limits,
    post: async (url, request) => {
      posts.push({ url, ...request });
      return post ? post(url, request) : (answers.shift() ?? { status: 200, outcome: "conversation" });
    },
  });
  const { port } = server.server.address() as { port: number };
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
  const send = (from: string, to: string[], text = "Hello") => transport.sendMail({ envelope: { from, to }, from, to, subject: "Help", text });
  /** A message as it is, headers and all. */
  const sendRaw = (from: string, to: string[], raw: string) => transport.sendMail({ envelope: { from, to }, raw });
  /** A raw connection (from `localAddress`, 127.0.0.1 by default): what the server says first, and when it hangs up. */
  const open = (localAddress?: string) =>
    new Promise<{
      greeting: string;
      closed: Promise<void>;
      write: (line: string) => void;
      /** Waits for a reply line starting with `code` (after what was already read). */
      reply: (code: string) => Promise<void>;
      end: () => void;
    }>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1", ...(localAddress && { localAddress }) });
      const closed = new Promise<void>((done) => socket.on("close", () => done()));
      let heard = "";
      socket.on("data", (data) => (heard += data.toString()));
      const reply = (code: string) =>
        vi.waitFor(() => {
          const at = heard.search(new RegExp(`(^|\r\n)${code} `));
          expect(at).toBeGreaterThanOrEqual(0);
          heard = heard.slice(heard.indexOf("\r\n", at + 2) + 2);
        });
      socket.once("data", (data) =>
        resolve({ greeting: data.toString(), closed, write: (line) => socket.write(`${line}\r\n`), reply, end: () => socket.destroy() }),
      );
    });
  /** Sends from another address (another network for 127.0.1.x). */
  const sendFrom = (localAddress: string, from: string, to: string[]) =>
    nodemailer.createTransport({ host: "127.0.0.1", port, localAddress, secure: false, ignoreTLS: true }).sendMail({ envelope: { from, to }, from, to, subject: "Help", text: "Hello" });
  return { posts, send, sendRaw, sendFrom, open };
}

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof receiver>>["open"]>>;

/** Starts a message on a raw session, up to DATA's go-ahead. */
async function startMessage(session: Session, to = "support@a.support.test") {
  for (const [line, code] of [
    ["EHLO sender.example", "250"],
    ["MAIL FROM:<sam@example.org>", "250"],
    [`RCPT TO:<${to}>`, "250"],
    ["DATA", "354"],
  ] as const) {
    session.write(line);
    await session.reply(code);
  }
}

test("mail for a project's address is posted to the app signed, with SPF and DMARC as checked here", async () => {
  const { posts, send } = await receiver();
  await send("sam@example.org", ["support@acme.support.test"]);
  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(post!.url).toBe("https://app.example.com/api/inbound/email");
  expect(post!.body.toString()).toContain("Subject: Help");
  expect(post!.headers["tuti-recipient"]).toBe("support@acme.support.test");
  expect(post!.headers["tuti-auth"]).toBe("spf=pass dkim=none dmarc=pass");
  expect(inboundSignatureValid(SECRET, post!.headers["tuti-signature"]!, "support@acme.support.test", "spf=pass dkim=none dmarc=pass", post!.body)).toBe(true);
});

test("mail from a server its domain doesn't allow fails SPF and DMARC, and the app is told so", async () => {
  const { posts, send } = await receiver();
  await send("ceo@forged.example", ["support@acme.support.test"]);
  expect(posts[0]!.headers["tuti-auth"]).toBe("spf=fail dkim=none dmarc=fail");
});

test("only the support domain's subdomain addresses are taken: the server relays nothing", async () => {
  const { posts, send } = await receiver();
  await expect(send("sam@example.org", ["someone@example.com"])).rejects.toMatchObject({ responseCode: 550 });
  await expect(send("sam@example.org", ["x@support.test.evil.com"])).rejects.toMatchObject({ responseCode: 550 });
  expect(posts).toEqual([]);
});

test("what the app answers is what the sender hears: no project there, too large, or try again later", async () => {
  const unknown = await receiver([{ status: 404, outcome: "no such address" }]);
  await expect(unknown.send("sam@example.org", ["support@nobody.support.test"])).rejects.toMatchObject({ responseCode: 550 });
  server!.close();

  const down = await receiver([{ status: 503 }]);
  await expect(down.send("sam@example.org", ["support@acme.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  server!.close();

  // The app's email switched off (a 404 that isn't "no such address") or a signature it refuses (a
  // different INBOUND_SECRET): setups to fix, so the sender keeps the mail and tries again.
  const off = await receiver([{ status: 404 }]);
  await expect(off.send("sam@example.org", ["support@acme.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  server!.close();
  const unsigned = await receiver([{ status: 401 }]);
  await expect(unsigned.send("sam@example.org", ["support@acme.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  server!.close();

  // Two recipients, one without a project: taken, for the one that has.
  const mixed = await receiver([{ status: 404, outcome: "no such address" }, { status: 200 }]);
  await mixed.send("sam@example.org", ["support@nobody.support.test", "support@acme.support.test"]);
  expect(mixed.posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@nobody.support.test", "support@acme.support.test"]);
});

test("a message over the limit is refused (552) and never posted", async () => {
  const { posts, send } = await receiver([], { maxBytes: 2048 });
  await expect(send("sam@example.org", ["support@acme.support.test"], "x".repeat(10_000))).rejects.toMatchObject({ responseCode: 552 });
  expect(posts).toEqual([]);
});

test("recipients past the limit are told to come separately (452), and only the others are posted", async () => {
  const { posts, send } = await receiver([], { maxRecipients: 2 });
  const sent = await send("sam@example.org", ["support@a.support.test", "support@b.support.test", "support@c.support.test"]);
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@a.support.test", "support@b.support.test"]);
  expect(sent.rejected).toEqual(["support@c.support.test"]);
});

test("one address can't hold every connection: past its share it's told to come back (421)", async () => {
  const { open } = await receiver([], { maxPerSource: 1 });
  const first = await open();
  const second = await open();
  expect(first.greeting).toMatch(/^220 /);
  expect(second.greeting).toMatch(/^421 /);
  first.end();
  second.end();
});

test("a session is closed past its lifetime, however busy it keeps itself", async () => {
  const { open } = await receiver([], { sessionLifetimeMs: 300 });
  const session = await open();
  const busy = setInterval(() => session.write("NOOP"), 50);
  await session.closed;
  clearInterval(busy);
});

test("messages still being delivered count, even after their sender hangs up: past the limit, try again later (451)", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const { send, posts } = await receiver([], { maxInFlight: 1 }, async () => {
    await slow;
    return { status: 200, outcome: "conversation" };
  });
  const first = send("sam@example.org", ["support@a.support.test"]);
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  await expect(send("sam@example.org", ["support@b.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  release();
  await first;
  await send("sam@example.org", ["support@c.support.test"]);
  expect(posts).toHaveLength(2);
});

test("messages still arriving share a budget of bytes: one that would go past it is refused (451), and a sender hanging up halfway frees its share", async () => {
  const { open, send, posts } = await receiver([], { maxBufferedBytes: 2_000 });
  const quitter = await open();
  await startMessage(quitter);
  quitter.write(`X-Big: ${"x".repeat(1_900)}`);
  // Its bytes are held: another message, a few hundred bytes, would go past the budget; alone, it fits.
  await vi.waitFor(() => expect(send("sam@example.org", ["support@x.support.test"])).rejects.toMatchObject({ responseCode: 451 }));
  quitter.end();
  await quitter.closed;
  await vi.waitFor(() => expect(send("sam@example.org", ["support@b.support.test"])).resolves.toBeDefined());
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@b.support.test"]);
});

/** A message carrying `count` DKIM signatures from signer.example (whose keys are never found): right for the body, so each is a lookup. */
const signed = (count: number) =>
  [
    ...Array.from(
      { length: count },
      (_, i) => `DKIM-Signature: v=1; a=rsa-sha256; c=simple/simple; d=signer.example; s=s${i}; h=from; bh=${createHash("sha256").update("Hello\r\n").digest("base64")}; b=AAAA`,
    ),
    "From: sam@example.org",
    "To: support@acme.support.test",
    "Subject: Help",
    "",
    "Hello",
    "",
  ].join("\r\n");

/** DNS whose DKIM keys are never found, each answer just inside a lookup's limit (on the fake clock); the rest as `resolver`. */
const slowKeys = (lookups: string[]) => (name: string, type: string) => {
  lookups.push(name);
  return name.includes("._domainkey.")
    ? new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" })), LOOKUP_TIMEOUT_MS - 1_000))
    : resolver(name, type);
};

test("checks that run past their deadline, our DNS answering, can't pass DMARC, and the message's place is freed", async () => {
  const lookups: string[] = [];
  const { open, sendRaw, posts } = await receiver([], { maxInFlight: 1, resolver: slowKeys(lookups) });
  const session = await open();
  await startMessage(session);
  // The checks' timers from here on are fake.
  fakeCheckTimers();
  session.write(`${signed(MAX_DKIM_SIGNATURES)}\r\n.`);
  // The deadline starts with the checks: move the clock only once they're under way.
  await vi.waitFor(() => expect(lookups).not.toEqual([]));
  await elapse(AUTH_TIMEOUT_MS + PROBE_TIMEOUT_MS + 1_000);
  vi.useRealTimers();
  await session.reply("250");
  session.end();
  // The probe of our own name was answered (no MX there): the delay was the sender's.
  expect(lookups).toContain("support.test");
  expect(posts[0]!.headers["tuti-auth"]).toBe("spf=none dkim=none dmarc=fail");
  await sendRaw("sam@example.org", ["support@b.support.test"], signed(0));
  expect(posts).toHaveLength(2);
});

test("checks that run past their deadline because our own DNS doesn't answer leave the message untaken: try again later (451)", async () => {
  const lookups: string[] = [];
  const slow = slowKeys(lookups);
  // Nothing answers for our own name either.
  const down = (name: string, type: string) => (name === "support.test" ? new Promise<never>(() => {}) : slow(name, type));
  const { open, posts } = await receiver([], { resolver: down });
  const session = await open();
  await startMessage(session);
  fakeCheckTimers();
  session.write(`${signed(MAX_DKIM_SIGNATURES)}\r\n.`);
  await vi.waitFor(() => expect(lookups).not.toEqual([]));
  await elapse(AUTH_TIMEOUT_MS + PROBE_TIMEOUT_MS + 1_000);
  vi.useRealTimers();
  await session.reply("451");
  session.end();
  expect(posts).toEqual([]);
});

const from127 = { ip: "127.0.0.1", helo: "mail.example.org", serverName: "mx.support.test", probe: "support.test" };

test("checks whose DNS answers just inside each lookup's limit still end by their deadline, and can't pass DMARC", async () => {
  fakeCheckTimers();
  const result = checkAuth(Buffer.from(signed(MAX_DKIM_SIGNATURES)), { ...from127, sender: "sam@example.org", resolver: slowKeys([]) });
  await elapse(AUTH_TIMEOUT_MS + PROBE_TIMEOUT_MS + 1_000);
  await expect(result).resolves.toEqual({ spf: "none", dkim: "none", dmarc: "fail" });
});

test("a DKIM key lookup that never answers gives up on its own, and SPF and DMARC are still checked", async () => {
  fakeCheckTimers();
  const silentKeys = (name: string, type: string) => (name.includes("._domainkey.") ? new Promise<never>(() => {}) : resolver(name, type));
  const result = checkAuth(Buffer.from(signed(1).replace("From: sam@example.org", "From: ceo@forged.example")), {
    ...from127,
    sender: "ceo@forged.example",
    resolver: silentKeys,
  });
  await elapse(LOOKUP_TIMEOUT_MS + 1_000);
  await expect(result).resolves.toEqual({ spf: "fail", dkim: "temperror", dmarc: "fail" });
});

test("a message with more DKIM signatures than any sender adds isn't checked, and can't pass DMARC", async () => {
  const lookups: string[] = [];
  const counting = (name: string, type: string) => {
    lookups.push(name);
    return resolver(name, type);
  };
  const { sendRaw, posts } = await receiver([], { resolver: counting });
  await sendRaw("sam@example.org", ["support@a.support.test"], signed(11));
  // However its lines end.
  await sendRaw("sam@example.org", ["support@a.support.test"], signed(11).replaceAll("\r\n", "\n"));
  expect(lookups).toEqual([]);
  expect(posts.map((post) => post.headers["tuti-auth"])).toEqual(["spf=none dkim=none dmarc=fail", "spf=none dkim=none dmarc=fail"]);
  // At the limit, they're checked.
  await sendRaw("sam@example.org", ["support@a.support.test"], signed(10));
  expect(lookups).toContain("s9._domainkey.signer.example");
});

test("a message with no blank line is all header: checked when it's short, not when it's longer than a header can be", async () => {
  const lookups: string[] = [];
  const counting = (name: string, type: string) => {
    lookups.push(name);
    return resolver(name, type);
  };
  const { sendRaw, posts } = await receiver([], { resolver: counting });
  const headerOnly = "From: sam@example.org\r\nTo: support@acme.support.test\r\nSubject: Help\r\n";
  await sendRaw("sam@example.org", ["support@a.support.test"], headerOnly);
  expect(posts[0]!.headers["tuti-auth"]).toBe("spf=pass dkim=none dmarc=pass");
  lookups.length = 0;
  const filler = Array.from({ length: Math.ceil(MAX_HEADER_BYTES / 900) }, () => `X-Filler: ${"x".repeat(900)}\r\n`).join("");
  await sendRaw("sam@example.org", ["support@a.support.test"], headerOnly + filler);
  expect(lookups).toEqual([]);
  expect(posts[1]!.headers["tuti-auth"]).toBe("spf=none dkim=none dmarc=fail");
});

test("a header that ends right at the limit is checked, its blank line just past it", async () => {
  const { sendRaw, posts } = await receiver();
  let header = "From: sam@example.org\r\nTo: support@acme.support.test\r\nSubject: Help\r\n";
  while (MAX_HEADER_BYTES - header.length > 950) {
    header += `X-Filler: ${"x".repeat(900)}\r\n`;
  }
  header += `X-Filler: ${"x".repeat(MAX_HEADER_BYTES - header.length - "X-Filler: \r\n".length)}\r\n`;
  // Its last line ends on the limit's last byte; the blank line after it is past the limit.
  expect(header.length).toBe(MAX_HEADER_BYTES);
  await sendRaw("sam@example.org", ["support@a.support.test"], `${header}\r\nHello\r\n`);
  expect(posts[0]!.headers["tuti-auth"]).toBe("spf=pass dkim=none dmarc=pass");
});

test("a session that sends no message is closed after a minute, long before its lifetime, however busy it keeps itself", async () => {
  fakeSessionClock();
  const { open } = await receiver();
  const session = await open();
  session.write("EHLO idle.example");
  await session.reply("250");
  for (const _ of [1, 2]) {
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS / 2);
    session.write("NOOP");
    await session.reply("250");
  }
  vi.advanceTimersByTime(IDLE_TIMEOUT_MS / 2);
  await session.closed;
});

test("a session isn't idle while its message is delivered, and is again once it's answered", async () => {
  fakeSessionClock();
  let release!: () => void;
  const { open, posts } = await receiver([], {}, async () => {
    if (posts.length === 1) {
      await new Promise<void>((resolve) => (release = resolve));
    }
    return { status: 200, outcome: "conversation" };
  });
  const session = await open();
  await startMessage(session);
  session.write("Subject: Help\r\n\r\nHello\r\n.");
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  // Long past every deadline while it's delivered: still open, and its answer is heard.
  vi.advanceTimersByTime(ARRIVAL_TIMEOUT_MS + IDLE_TIMEOUT_MS);
  release();
  await session.reply("250");
  // Another message on the same session.
  for (const [line, code] of [
    ["MAIL FROM:<sam@example.org>", "250"],
    ["RCPT TO:<support@b.support.test>", "250"],
    ["DATA", "354"],
    ["Subject: Help\r\n\r\nHello\r\n.", "250"],
  ] as const) {
    session.write(line);
    await session.reply(code);
  }
  expect(posts).toHaveLength(2);
  // Quiet from then on: closed.
  vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 30_000);
  await session.closed;
});

test("a message being delivered still counts against the budget until it's answered", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  // Room for one message of a few hundred bytes, not two.
  const { send, posts } = await receiver([], { maxBufferedBytes: 400 }, async () => {
    if (posts.length === 1) {
      await slow;
    }
    return { status: 200, outcome: "conversation" };
  });
  const first = send("sam@example.org", ["support@a.support.test"]);
  await vi.waitFor(() => expect(posts).toHaveLength(1));
  await expect(send("sam@example.org", ["support@b.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  release();
  await first;
  await send("sam@example.org", ["support@c.support.test"]);
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@a.support.test", "support@c.support.test"]);
});

// Linux routes all of 127.0.0.0/8 to loopback, so 127.0.1.1 is another network; macOS has only 127.0.0.1 (CI runs Linux).
test.skipIf(process.platform === "darwin")("senders trickling their messages in hold no place: another network's mail is taken, and they're cut off at the arrival deadline", async () => {
  fakeSessionClock();
  const { open, sendFrom, posts } = await receiver([], { maxInFlight: 1 });
  const tricklers = await Promise.all(Array.from({ length: MAX_PER_SOURCE }, () => open()));
  for (const trickler of tricklers) {
    await startMessage(trickler);
    trickler.write("Subject: Slow");
  }
  // Past the idle timeout, a byte more each: still arriving.
  vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 30_000);
  tricklers.forEach((trickler) => trickler.write("X"));
  await sendFrom("127.0.1.1", "sam@example.org", ["support@b.support.test"]);
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@b.support.test"]);
  vi.advanceTimersByTime(ARRIVAL_TIMEOUT_MS);
  await Promise.all(tricklers.map((trickler) => trickler.closed));
});

// 127.0.0.3 is in 127.0.0.1's /24 (Linux only: macOS has only 127.0.0.1; CI runs Linux).
test.skipIf(process.platform === "darwin")("one network can't have every message being checked and delivered: past its share, try again later (451)", async () => {
  expect(MAX_IN_FLIGHT_PER_SOURCE).toBeLessThan(MAX_IN_FLIGHT / 3);
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const { send, sendFrom, posts } = await receiver([], {}, async () => {
    await slow;
    return { status: 200, outcome: "conversation" };
  });
  const delivering = Array.from({ length: MAX_IN_FLIGHT_PER_SOURCE }, (_, i) => send("sam@example.org", [`support@d${i}.support.test`]));
  await vi.waitFor(() => expect(posts).toHaveLength(MAX_IN_FLIGHT_PER_SOURCE));
  // From another address in the same network.
  await expect(sendFrom("127.0.0.3", "sam@example.org", ["support@b.support.test"])).rejects.toMatchObject({ responseCode: 451 });
  release();
  await Promise.all(delivering);
  await send("sam@example.org", ["support@c.support.test"]);
});

// Linux routes all of 127.0.0.0/8 to loopback; macOS has only 127.0.0.1 (CI runs Linux).
test.skipIf(process.platform === "darwin")("two addresses in one network share its connections, and one closing frees a place for either", async () => {
  const { open } = await receiver([], { maxPerSource: 2 });
  const first = await open("127.0.0.1");
  const second = await open("127.0.0.3");
  expect([first.greeting, second.greeting]).toEqual([expect.stringMatching(/^220 /), expect.stringMatching(/^220 /)]);
  const third = await open("127.0.0.3");
  expect(third.greeting).toMatch(/^421 /);
  first.end();
  await first.closed;
  await vi.waitFor(async () => {
    const next = await open("127.0.0.3");
    next.end();
    expect(next.greeting).toMatch(/^220 /);
  });
  second.end();
  third.end();
});

test("connections are counted by network (IPv4 /24, IPv6 /48), and a few networks can't take them all", () => {
  expect(sourceOf("::ffff:198.51.100.1")).toBe(sourceOf("198.51.100.2"));
  expect(sourceOf("198.51.100.1")).not.toBe(sourceOf("198.51.101.1"));
  expect(sourceOf("2001:db8::1")).toBe(sourceOf("2001:db8:0:0:1::2"));
  expect(sourceOf("2001:DB8:0000::1")).toBe(sourceOf("2001:db8::ffff"));
  // A customer's /56 or /48 is one network.
  expect(sourceOf("2001:db8:0:ff00::1")).toBe(sourceOf("2001:db8::1"));
  expect(sourceOf("2001:db8:1::1")).not.toBe(sourceOf("2001:db8::1"));
  expect(MAX_CLIENTS).toBeGreaterThanOrEqual(10 * MAX_PER_SOURCE);
});

test("off without INBOUND_SMTP_PORT; with it, the rest is needed", () => {
  expect(receiverFromEnv({})).toBeNull();
  expect(() => receiverFromEnv({ INBOUND_SMTP_PORT: "25" })).toThrow("SUPPORT_EMAIL_DOMAIN, INBOUND_SECRET, APP_URL");
  expect(() => receiverFromEnv({ INBOUND_SMTP_PORT: "25", SUPPORT_EMAIL_DOMAIN: "support.test", INBOUND_SECRET: SECRET, APP_URL: "https://app.example.com", INBOUND_SMTP_TLS_KEY: "/key.pem" })).toThrow(
    "INBOUND_SMTP_TLS_CERT",
  );
  expect(receiverFromEnv({ INBOUND_SMTP_PORT: "2525", SUPPORT_EMAIL_DOMAIN: "support.test", INBOUND_SECRET: SECRET, APP_URL: "https://app.example.com" })).toMatchObject({
    port: 2525,
    domain: "support.test",
  });
});
