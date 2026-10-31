import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";

import { mailSubdomain, supportAddress } from "./inbound";
import { upsertProjectUser } from "./project-users";

/** Receiving email (server/inbound.ts, /api/inbound/email): fixture emails as the receiver posts them. */

const DOMAIN = "tuti.email";

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});

async function setup() {
  const project = await createProject(await signUp("Olive Owner"));
  const subdomain = await mailSubdomain(project.id);
  return { project, address: supportAddress(subdomain, DOMAIN), subdomain };
}

const conversations = (projectId: string) =>
  prisma.conversation.findMany({
    where: { projectId },
    orderBy: { number: "asc" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
const inbound = (projectId: string) => prisma.inboundEmail.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });

test("an email to the project's address starts a conversation with its sender, without the quoted part, and the raw message goes once read", async () => {
  const { project, address, subdomain } = await setup();
  expect(subdomain).toBe(project.slug);
  const raw = rawEmail({
    from: "Kim Lee <e2e-kim@example.com>",
    to: "support@acme.example",
    subject: "Re: Fwd: Export broken",
    body: "It still doesn't work.\r\n\r\nOn Mon, 27 Oct 2026 at 09:00, Someone <x@example.com> wrote:\r\n> Try again",
  });
  expect(await postEmail(raw, { recipient: address })).toEqual({ status: 200, body: { outcome: "added" } });

  const [conversation] = await conversations(project.id);
  expect(conversation).toMatchObject({ number: 1, origin: "EMAIL", subject: "Export broken", email: "e2e-kim@example.com", emailVerified: true, spam: false });
  expect(conversation!.messages[0]).toMatchObject({ channel: "EMAIL", body: "It still doesn't work.", original: expect.stringContaining("> Try again") });
  expect(await inbound(project.id)).toMatchObject([{ status: "ADDED", raw: null, conversationId: conversation!.id, dmarc: "pass" }]);

  // Delivered again: nothing new.
  expect(await postEmail(raw, { recipient: address })).toEqual({ status: 200, body: { outcome: "added" } });
  expect(await conversations(project.id)).toHaveLength(1);
  expect(await inbound(project.id)).toHaveLength(1);
});

test("an email with only an HTML body (an image in it, no plain-text part) arrives as its text, links kept and the part it quotes cut", async () => {
  const { project, address } = await setup();
  const html = [
    "From: Kim Lee <e2e-kim@example.com>",
    `To: ${address}`,
    "Subject: Export",
    `Message-ID: <${crypto.randomUUID()}@mail.example.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="related"',
    "",
    "--related",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<div><p>The <b>export</b> fails on <a href="https://acme.example/reports">the reports page</a>.</p><img src="cid:shot@example.com"></div>',
    '<div class="gmail_quote">On Mon, Olive wrote:<blockquote>Can you try again?</blockquote></div>',
    "--related",
    "Content-Type: image/png",
    "Content-ID: <shot@example.com>",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("png").toString("base64"),
    "--related--",
    "",
  ].join("\r\n");
  expect(await postEmail(html, { recipient: address })).toMatchObject({ status: 200 });
  const [conversation] = await conversations(project.id);
  const body = conversation!.messages[0]!.body;
  expect(body).toBe("The export fails on the reports page [https://acme.example/reports].");
  expect(conversation!.messages[0]!.original).toContain("> Can you try again?");
});

test("the subdomain is the project's for good: taken names get a number, and a renamed project keeps its own", async () => {
  const first = await setup();
  await prisma.project.update({ where: { id: first.project.id }, data: { slug: `${first.project.slug}-renamed` } });
  expect(await mailSubdomain(first.project.id)).toBe(first.subdomain);
  // Another project now with the old slug gets a numbered subdomain.
  const second = await createProject(await signUp());
  await prisma.project.update({ where: { id: second.id }, data: { slug: first.project.slug } });
  expect(await mailSubdomain(second.id)).toBe(`${first.project.slug}-2`);
  // Even once the first project is gone, its subdomain stays out of reach.
  await prisma.project.delete({ where: { id: first.project.id } });
  expect(await prisma.mailSubdomain.findUnique({ where: { subdomain: first.subdomain } })).toMatchObject({ projectId: null });
  expect(await postEmail(rawEmail({ from: "e2e-kim@example.com", to: first.address }), { recipient: first.address })).toMatchObject({ status: 404 });
});

test("a reply to the conversation's address joins it, from its own person with DMARC passed only", async () => {
  const { project, address, subdomain } = await setup();
  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: address, subject: "Refund" }), { recipient: address });
  const { replyToken } = await prisma.conversation.findFirstOrThrow({ where: { projectId: project.id } });
  const replyAddress = supportAddress(subdomain, DOMAIN, replyToken);
  expect(replyToken).toMatch(/^[a-f0-9]{32}$/);

  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: replyAddress, subject: "Re: Refund", body: "Any news?" }), { recipient: replyAddress });
  // Same domain, another mailbox, with the secret: a new conversation, never theirs.
  await postEmail(rawEmail({ from: "e2e-colleague@example.com", to: replyAddress, subject: "Re: Refund", body: "Me too" }), { recipient: replyAddress });
  // Their address, but DMARC failed: someone posing as them; a new conversation, in Spam.
  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: replyAddress, subject: "Re: Refund", body: "Send it here" }), {
    recipient: replyAddress,
    auth: "spf=fail dkim=fail dmarc=fail",
  });

  const all = await conversations(project.id);
  expect(all.map((c) => ({ number: c.number, email: c.email, spam: c.spam, bodies: c.messages.map((m) => m.body) }))).toEqual([
    { number: 1, email: "e2e-kim@example.com", spam: false, bodies: ["Hello", "Any news?"] },
    { number: 2, email: "e2e-colleague@example.com", spam: false, bodies: ["Me too"] },
    { number: 3, email: "e2e-kim@example.com", spam: true, bodies: ["Send it here"] },
  ]);
  expect(all[2]!.emailVerified).toBe(false);
});

test("with DMARC passed, a known user's address is theirs; otherwise the address stays on its own", async () => {
  const { project, address } = await setup();
  const sam = await upsertProjectUser(project.id, "user-42", { name: "Sam", email: "e2e-sam@example.com" });
  await postEmail(rawEmail({ from: "e2e-sam@example.com", to: address, subject: "Mine" }), { recipient: address });
  await postEmail(rawEmail({ from: "e2e-sam@example.com", to: address, subject: "Posing" }), { recipient: address, auth: "spf=none dkim=none dmarc=none" });
  const [mine, posing] = await conversations(project.id);
  expect(mine).toMatchObject({ userId: sam, email: null });
  expect(posing).toMatchObject({ userId: null, email: "e2e-sam@example.com", emailVerified: false, spam: false });
});

test("auto-replies, bounces, our own mail and loops are kept as ignored, with the reason", async () => {
  const { project, address } = await setup();
  const post = (headers: Record<string, string>, from = "e2e-kim@example.com") =>
    postEmail(rawEmail({ from, to: address, headers }), { recipient: address });
  expect(await post({ "Auto-Submitted": "auto-replied" })).toEqual({ status: 200, body: { outcome: "auto_submitted" } });
  expect(await post({}, "MAILER-DAEMON@mx.example.com")).toEqual({ status: 200, body: { outcome: "bounce" } });
  expect(await post({ "X-Tuti-Loop": "acme" })).toEqual({ status: 200, body: { outcome: "loop" } });
  expect(await post({}, `support@other.${DOMAIN}`)).toEqual({ status: 200, body: { outcome: "from_own_address" } });
  expect(await conversations(project.id)).toEqual([]);
  expect((await inbound(project.id)).map((row) => [row.status, row.reason, row.raw])).toEqual([
    ["IGNORED", "auto_submitted", null],
    ["IGNORED", "bounce", null],
    ["IGNORED", "loop", null],
    ["IGNORED", "from_own_address", null],
  ]);
});

test("without a Message-ID, a redelivery is still known by its bytes; another sender reusing a Message-ID is still taken", async () => {
  const { project, address } = await setup();
  const raw = rawEmail({ from: "e2e-kim@example.com", to: address, messageId: null });
  await postEmail(raw, { recipient: address });
  await postEmail(raw, { recipient: address });
  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: address, messageId: "<same@example.com>" }), { recipient: address });
  await postEmail(rawEmail({ from: "e2e-lee@example.com", to: address, messageId: "<same@example.com>" }), { recipient: address });
  expect(await conversations(project.id)).toHaveLength(3);
});

test("signed by someone else, too old, or to an address nobody has: refused", async () => {
  const { address } = await setup();
  const raw = rawEmail({ from: "e2e-kim@example.com", to: address });
  expect(await postEmail(raw, { recipient: address, secret: "wrong" })).toMatchObject({ status: 401 });
  vi.useFakeTimers({ now: Date.now() - 10 * 60_000, toFake: ["Date"] });
  const old = await (async () => {
    const { signInbound } = await import("@/lib/inbound-signature");
    return signInbound("test-inbound-secret", address, "dmarc=pass", Buffer.from(raw));
  })();
  vi.useRealTimers();
  const { POST } = await import("@/app/api/inbound/email/route");
  const stale = await POST(
    new Request("http://tuti.localhost:3100/api/inbound/email", {
      method: "POST",
      headers: { "tuti-recipient": address, "tuti-auth": "dmarc=pass", "tuti-signature": old },
      body: raw,
    }),
  );
  expect(stale.status).toBe(401);
  const nobody = `support@nobody-here.${DOMAIN}`;
  expect(await postEmail(rawEmail({ from: "e2e-kim@example.com", to: nobody }), { recipient: nobody })).toMatchObject({ status: 404 });
});

test("over the hourly limit, mail is refused before its body is stored, and the rest still counts it", async () => {
  const { project, address } = await setup();
  await prisma.inboundEmail.createMany({
    data: Array.from({ length: 500 }, (_, i) => ({
      projectId: project.id,
      recipient: address,
      sender: "e2e-flood@example.com",
      dedupeKey: `flood-${i}`,
      size: 10,
      status: "IGNORED" as const,
    })),
  });
  expect(await postEmail(rawEmail({ from: "e2e-kim@example.com", to: address, subject: "One too many" }), { recipient: address })).toEqual({
    status: 200,
    body: { outcome: "refused" },
  });
  expect(await prisma.inboundEmail.findFirstOrThrow({ where: { projectId: project.id, subject: "One too many" } })).toMatchObject({
    status: "REFUSED",
    reason: "over_hourly_limit",
    raw: null,
    sender: "e2e-kim@example.com",
  });
  expect(await conversations(project.id)).toEqual([]);
});

test("raw bodies that couldn't be read go after 30 days; the rows stay. Projects' email counts go after 30 days", async () => {
  const { project, address } = await setup();
  const make = (days: number) =>
    prisma.inboundEmail.create({
      data: {
        projectId: project.id,
        recipient: address,
        sender: "e2e-kim@example.com",
        dedupeKey: `failed-${days}`,
        raw: new Uint8Array(Buffer.from("raw")),
        size: 3,
        status: "FAILED",
        createdAt: new Date(Date.now() - days * 24 * 60 * 60_000),
      },
    });
  const [old, recent] = [await make(31), await make(29)];
  const [oldDay, recentDay] = [31, 29].map((days) => new Date(new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10)));
  await prisma.projectEmailDay.createMany({ data: [oldDay!, recentDay!].map((day) => ({ projectId: project.id, day, sent: 1 })) });
  await handlers.pruneInboundEmails({}, { info: () => {}, warn: () => {} });
  expect(await prisma.projectEmailDay.findMany({ where: { projectId: project.id }, select: { day: true } })).toEqual([{ day: recentDay }]);
  expect((await prisma.inboundEmail.findUniqueOrThrow({ where: { id: old.id } })).raw).toBeNull();
  expect((await prisma.inboundEmail.findUniqueOrThrow({ where: { id: recent.id } })).raw).not.toBeNull();
});

test("the same message delivered several times at once is added once", async () => {
  const { project, address } = await setup();
  const raw = rawEmail({ from: "e2e-kim@example.com", to: address, subject: "At once" });
  const results = await Promise.all(Array.from({ length: 4 }, () => postEmail(raw, { recipient: address })));
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(await conversations(project.id)).toHaveLength(1);
  expect(await inbound(project.id)).toHaveLength(1);
});

test("an email forwarded from the team's own address shows its forwarding works; one that names another address doesn't", async () => {
  const { project, address } = await setup();
  await prisma.emailDomain.create({ data: { projectId: project.id, domain: "acme.example", address: "support@acme.example", dkimTokens: [] } });
  const receivedAt = async () => (await prisma.emailDomain.findUniqueOrThrow({ where: { projectId: project.id } })).receivedAt;

  // Sent to someone else at the domain (a teammate's own forwarding), and to an address that only contains it.
  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: "sales@acme.example, xsupport@acme.example" }), { recipient: address });
  expect(await receivedAt()).toBeNull();
  // Sent to the support address directly, the team's address beside it: nothing forwarded it.
  await postEmail(rawEmail({ from: "e2e-kim@example.com", to: address, headers: { Cc: "support@acme.example" } }), { recipient: address });
  expect(await receivedAt()).toBeNull();

  // Gmail's forwarding: To stays the team's address, and X-Forwarded-For names it too.
  await postEmail(rawEmail({ from: "Kim Lee <e2e-kim@example.com>", to: '"Acme Support" <Support@Acme.example>', headers: { "X-Forwarded-For": `support@acme.example ${address}` } }), {
    recipient: address,
  });
  expect(await receivedAt()).toBeInstanceOf(Date);
  expect(await conversations(project.id)).toHaveLength(3);
});
