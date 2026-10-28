import { afterEach, expect, test, vi } from "vitest";

import { confirmSubscriptionUrl, type SnsMessage, snsSignatureValid } from "./sns";

const TOPIC = "arn:aws:sns:eu-west-1:000000000000:tuti-support-events";
afterEach(() => vi.unstubAllEnvs());

const message = (fields: Partial<SnsMessage>): SnsMessage => ({
  Type: "Notification",
  MessageId: "m",
  TopicArn: TOPIC,
  Message: "{}",
  Timestamp: "2026-10-28T00:00:00Z",
  Signature: "c2ln",
  SignatureVersion: "2",
  SigningCertURL: "",
  ...fields,
});

test("a certificate anywhere but SNS in the topic's region is refused without fetching it", async () => {
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", TOPIC);
  vi.stubEnv("SES_API_URL", "");
  const fetched = vi.spyOn(globalThis, "fetch");
  for (const url of [
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-west-1.amazonaws.com.example.com/SimpleNotificationService-abc.pem",
    "https://example.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-west-1.amazonaws.com/other.pem",
  ]) {
    expect(await snsSignatureValid(message({ SigningCertURL: url }))).toBe(false);
  }
  expect(fetched).not.toHaveBeenCalled();
});

test("the subscription is confirmed at SNS in the topic's region, whatever link the message has", () => {
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", TOPIC);
  vi.stubEnv("SES_API_URL", "");
  expect(confirmSubscriptionUrl(message({ Type: "SubscriptionConfirmation", Token: "t&k", SubscribeURL: "https://example.com/" }))).toBe(
    `https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=t%26k`,
  );
});
