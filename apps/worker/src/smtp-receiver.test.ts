import { connect } from "node:net";

import { inboundSignatureValid } from "@tuti/shared/inbound-signature";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import { afterEach, expect, test, vi } from "vitest";

import { receiverFromEnv, startSmtpReceiver } from "./smtp-receiver";

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
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A receiver for support.test, posting to a fake app that answers `answers` in turn (then 200). */
type Limits = { maxBytes?: number; maxRecipients?: number; maxPerSource?: number; maxInFlight?: number; sessionLifetimeMs?: number };

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
  /** A raw connection: what the server says first, and when it hangs up. */
  const open = () =>
    new Promise<{ greeting: string; closed: Promise<void>; write: (line: string) => void; end: () => void }>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      const closed = new Promise<void>((done) => socket.on("close", () => done()));
      socket.once("data", (data) =>
        resolve({ greeting: data.toString(), closed, write: (line) => socket.write(`${line}\r\n`), end: () => socket.destroy() }),
      );
    });
  return { posts, send, open };
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

test("a sender that hangs up halfway through a message doesn't keep its place among the messages in flight", async () => {
  const { open, send, posts } = await receiver([], { maxInFlight: 1 });
  const quitter = await open();
  for (const line of ["EHLO quitter.example", "MAIL FROM:<sam@example.org>", "RCPT TO:<support@a.support.test>", "DATA", "Subject: Half"]) {
    quitter.write(line);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  quitter.end();
  await quitter.closed;
  await vi.waitFor(() => expect(send("sam@example.org", ["support@b.support.test"])).resolves.toBeDefined());
  expect(posts.map((post) => post.headers["tuti-recipient"])).toEqual(["support@b.support.test"]);
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
