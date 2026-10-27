import { inboundSignatureValid } from "@/lib/inbound-signature";
import { MAX_RECEIVED_BYTES, receiveEmail, supportDomain } from "@/server/inbound";

/**
 * Where received mail comes in (docs/plan.md, Support inbox, "Receiving email"; docs/support-email.md):
 * the raw message as the body, the envelope recipient in `Tuti-Recipient`, the receiver's
 * authentication results in `Tuti-Auth` (`spf=pass dkim=pass dmarc=pass`), all signed together in
 * `Tuti-Signature` with INBOUND_SECRET (lib/inbound-signature.ts). Answers 200 once it's taken (or
 * ignored, or refused over a limit), 404 for an address nobody has, and 500 when the receiver should
 * try again. Off (404) without SUPPORT_EMAIL_DOMAIN and INBOUND_SECRET.
 */
export async function POST(request: Request) {
  const secret = process.env.INBOUND_SECRET;
  if (!secret || !supportDomain()) {
    return Response.json({ error: "This server doesn't receive email" }, { status: 404 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RECEIVED_BYTES) {
    return Response.json({ error: "Too large" }, { status: 413 });
  }
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_RECEIVED_BYTES) {
    return Response.json({ error: "Too large" }, { status: 413 });
  }
  const recipient = request.headers.get("tuti-recipient") ?? "";
  const auth = request.headers.get("tuti-auth") ?? "";
  if (!recipient || !inboundSignatureValid(secret, request.headers.get("tuti-signature") ?? "", recipient, auth, raw)) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  const result = (name: string) => /^(pass|fail|none|neutral|softfail|temperror|permerror)$/.exec(new RegExp(`(?:^|\\s)${name}=(\\w+)`).exec(auth)?.[1] ?? "")?.[1] ?? "none";
  const received = await receiveEmail(recipient, { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") }, raw);
  return Response.json({ outcome: received.outcome }, { status: received.status });
}
