import { expect, test } from "vitest";

import { snsUrl } from "./sns";

test("only SNS's own https addresses are fetched: certificates and subscription links", () => {
  expect(snsUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem")).toBe(true);
  expect(snsUrl("https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=x")).toBe(true);
  for (const url of [
    "http://sns.us-east-1.amazonaws.com/cert.pem",
    "https://sns.us-east-1.amazonaws.com.example.com/cert.pem",
    "https://example.com/sns.us-east-1.amazonaws.com/cert.pem",
    "https://s3.amazonaws.com/cert.pem",
    "not a url",
    undefined,
  ]) {
    expect(snsUrl(url)).toBe(false);
  }
});
