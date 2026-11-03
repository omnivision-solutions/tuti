import { createHash, createHmac, randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import { APP_URL, INBOUND_SECRET } from "./env";

/** A plain-text email. */
export function rawEmail(from: string, subject: string, body: string) {
  return [`From: ${from}`, `Subject: ${subject}`, `Message-ID: <${randomUUID()}@mail.example.com>`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
}

/** Posts `raw` to /api/inbound/email as the receiver does, signed, with DMARC passed. */
export async function receive(recipient: string, raw: string) {
  const auth = "spf=pass dkim=pass dmarc=pass";
  const body = Buffer.from(raw);
  const t = Math.floor(Date.now() / 1000);
  const hash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", INBOUND_SECRET).update(`${t}.${recipient}.${auth}.${hash}`).digest("hex");
  const response = await fetch(`${APP_URL}/api/inbound/email`, {
    method: "POST",
    headers: { "tuti-recipient": recipient, "tuti-auth": auth, "tuti-signature": `t=${t},v1=${signature}` },
    body,
  });
  expect(response.status).toBe(200);
}
