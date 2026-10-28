import { createVerify } from "node:crypto";

/**
 * Amazon SNS's HTTPS messages (docs/plan.md, Support inbox, item 11: SES's events come through SNS),
 * checked the way AWS documents: the signature over the message's fields, with the certificate it
 * names, which must be SNS's own in the events topic's region.
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

/**
 * SNS in the events topic's region (in tests, the SES fake): everything fetched is there, its address
 * made from the server's settings, never taken from a message.
 */
function sns(): string {
  const fake = process.env.SES_API_URL?.replace(/\/$/, "");
  return fake ? `${fake}/sns` : `https://sns.${process.env.SES_EVENTS_TOPIC_ARN?.split(":")[3]}.amazonaws.com`;
}

/** The link that confirms a subscription to the topic (what SNS's SubscribeURL is). */
export function confirmSubscriptionUrl(message: SnsMessage): string {
  return `${sns()}/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(message.TopicArn)}&Token=${encodeURIComponent(message.Token ?? "")}`;
}

/** Certificates by URL: SNS signs with a few, for months each. */
const certificates = new Map<string, string>();

export async function snsSignatureValid(message: SnsMessage): Promise<boolean> {
  const fields = Object.hasOwn(SIGNED, message.Type) ? SIGNED[message.Type] : null;
  const algorithm = message.SignatureVersion === "1" ? "RSA-SHA1" : message.SignatureVersion === "2" ? "RSA-SHA256" : null;
  // The certificate is SNS's (SimpleNotificationService-<id>.pem), from SNS in the topic's region.
  const file = /^SimpleNotificationService-[\w-]+\.pem$/.exec(String(message.SigningCertURL).split("/").at(-1) ?? "")?.[0];
  const url = file && `${sns()}/${file}`;
  if (!fields || !algorithm || !url || message.SigningCertURL !== url) {
    return false;
  }
  let certificate = certificates.get(url);
  if (!certificate) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return false;
    }
    certificate = await response.text();
    certificates.set(url, certificate);
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
