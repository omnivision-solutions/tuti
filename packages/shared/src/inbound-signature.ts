import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * How whatever receives mail for the support domain (tuti.so's SES Lambda, a self-hosted server's SMTP
 * receiver, a script) proves a message to /api/inbound/email came from it: `Tuti-Signature: t=<unix
 * seconds>,v1=<hex HMAC-SHA256>`, keyed with INBOUND_SECRET, over `<t>.<recipient>.<auth>.<SHA-256 of
 * the raw message, hex>`, so the recipient and the authentication results can't be swapped either.
 * Accepted for 5 minutes either side of now.
 */

const TOLERANCE_SECONDS = 5 * 60;

const signed = (timestamp: number, recipient: string, auth: string, raw: Buffer) =>
  `${timestamp}.${recipient}.${auth}.${createHash("sha256").update(raw).digest("hex")}`;

export function signInbound(secret: string, recipient: string, auth: string, raw: Buffer, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(signed(t, recipient, auth, raw)).digest("hex")}`;
}

export function inboundSignatureValid(secret: string, header: string, recipient: string, auth: string, raw: Buffer, now = Date.now()) {
  const t = Number(/(?:^|,)t=(\d{1,12})(?:,|$)/.exec(header)?.[1]);
  const given = /(?:^|,)v1=([a-f0-9]{64})(?:,|$)/.exec(header)?.[1];
  if (!given || !Number.isFinite(t) || Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) {
    return false;
  }
  const wanted = createHmac("sha256", secret).update(signed(t, recipient, auth, raw)).digest();
  return timingSafeEqual(Buffer.from(given, "hex"), wanted);
}
