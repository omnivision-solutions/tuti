import { randomUUID } from "node:crypto";

import { POST } from "@/app/api/inbound/email/route";
import { signInbound } from "@/lib/inbound-signature";

/**
 * Received mail for tests: a raw message as a mail provider would deliver it, posted to
 * /api/inbound/email the way the receiver does (signed with INBOUND_SECRET), with its
 * authentication results.
 */

export function rawEmail({
  from,
  to,
  subject = "Help",
  body = "Hello",
  messageId = `<${randomUUID()}@mail.example.com>`,
  headers = {},
}: {
  from: string;
  to: string;
  subject?: string;
  body?: string;
  messageId?: string | null;
  headers?: Record<string, string>;
}) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "Date: Mon, 27 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    body,
  ];
  return lines.join("\r\n");
}

export async function postEmail(
  raw: string,
  { recipient, auth = "spf=pass dkim=pass dmarc=pass", secret = process.env.INBOUND_SECRET! }: { recipient: string; auth?: string; secret?: string },
) {
  const bytes = Buffer.from(raw);
  const response = await POST(
    new Request("http://tuti.localhost:3100/api/inbound/email", {
      method: "POST",
      headers: { "tuti-recipient": recipient, "tuti-auth": auth, "tuti-signature": signInbound(secret, recipient, auth, bytes) },
      body: bytes,
    }),
  );
  return { status: response.status, body: (await response.json()) as { outcome?: string; error?: string } };
}
