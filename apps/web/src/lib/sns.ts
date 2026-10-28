import { createVerify } from "node:crypto";

/**
 * Amazon SNS's HTTPS messages (docs/plan.md, Support inbox, item 11: SES's events come through SNS),
 * checked the way AWS documents: the signature over the message's fields, with the certificate from
 * the URL it names, which must be SNS's own.
 */
export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

/** What each type signs, in this order. */
const SIGNED: Record<string, (keyof SnsMessage)[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

/** An address on SNS itself (https://sns.<region>.amazonaws.com/…), or, in tests, on the SES fake. */
export function snsUrl(url: string | undefined): boolean {
  const fake = process.env.SES_API_URL?.replace(/\/$/, "");
  if (url && fake && url.startsWith(`${fake}/`)) {
    return true;
  }
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Certificates by URL: SNS signs with a few, for months each. */
const certificates = new Map<string, string>();

export async function snsSignatureValid(message: SnsMessage): Promise<boolean> {
  const fields = SIGNED[message.Type];
  const algorithm = { "1": "RSA-SHA1", "2": "RSA-SHA256" }[message.SignatureVersion];
  if (!fields || !algorithm || !snsUrl(message.SigningCertURL) || !new URL(message.SigningCertURL).pathname.endsWith(".pem")) {
    return false;
  }
  let certificate = certificates.get(message.SigningCertURL);
  if (!certificate) {
    const response = await fetch(message.SigningCertURL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return false;
    }
    certificate = await response.text();
    certificates.set(message.SigningCertURL, certificate);
  }
  const signed = fields
    .filter((field) => typeof message[field] === "string")
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
  try {
    return createVerify(algorithm).update(signed).verify(certificate, message.Signature, "base64");
  } catch {
    return false;
  }
}
