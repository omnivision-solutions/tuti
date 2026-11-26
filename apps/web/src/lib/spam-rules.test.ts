import { describe, expect, test } from "vitest";

import { describeSpamRule, matchesPattern, type SpamRule, type SpamRuleInput, spamRuleKey, spamRuleMatches } from "./spam-rules";

const matches = (field: SpamRule["field"], matcher: SpamRule["matcher"], value: string, input: SpamRuleInput) => spamRuleMatches({ field, matcher, value }, input);

describe("each field", () => {
  test("sender domain: is matches the domain and its subdomains, never the domain above or a look-alike", () => {
    expect(matches("sender_domain", "is", "Spam.example", { domain: "spam.example" })).toBe(true);
    expect(matches("sender_domain", "is", "spam.example", { domain: "m2.SPAM.example" })).toBe(true);
    expect(matches("sender_domain", "is", "m1.spam.example", { domain: "spam.example" })).toBe(false);
    expect(matches("sender_domain", "is", "spam.example", { domain: "notspam.example" })).toBe(false);
    expect(matches("sender_domain", "ends_with", ".ru", { domain: "mail.shop.ru" })).toBe(true);
  });

  test("sender address, sender name, sent to", () => {
    expect(matches("sender_address", "is", "kim@spam.example", { address: "KIM@spam.example" })).toBe(true);
    expect(matches("sender_address", "starts_with", "noreply", { address: "noreply@acme.example" })).toBe(true);
    expect(matches("sender_name", "contains", "facebook", { name: "Meta Facebook Support" })).toBe(true);
    expect(matches("sender_name", "is", "facebook", { name: null })).toBe(false);
    expect(matches("sent_to", "is", "sales@acme.example", { sentTo: ["help@acme.example", "Sales@Acme.example"] })).toBe(true);
    expect(matches("sent_to", "is", "sales@acme.example", {})).toBe(false);
  });

  test("subject, body, and subject or body (each on its own, never across the two)", () => {
    const input = { subject: "Your page", text: "will be disabled" };
    expect(matches("subject", "contains", "page", input)).toBe(true);
    expect(matches("subject", "contains", "disabled", input)).toBe(false);
    expect(matches("body", "contains", "disabled", input)).toBe(true);
    expect(matches("subject_or_body", "contains", "disabled", input)).toBe(true);
    expect(matches("subject_or_body", "contains", "page will", input)).toBe(false);
  });
});

describe("each matcher, ignoring case", () => {
  test("is, starts with, ends with", () => {
    expect(matches("subject", "is", "hello  there", { subject: " HELLO there " })).toBe(true);
    expect(matches("subject", "is", "hello", { subject: "hello there" })).toBe(false);
    expect(matches("subject", "starts_with", "re: offer", { subject: "RE: Offer inside" })).toBe(true);
    expect(matches("body", "ends_with", "unsubscribe", { text: "Deals.\nUNSUBSCRIBE" })).toBe(true);
  });

  test("contains on the subject and body is whole words, any punctuation between them; on other fields any part", () => {
    expect(matches("subject", "contains", "sex", { subject: "Visiting Essex" })).toBe(false);
    expect(matches("subject", "contains", "sex", { subject: "Hot SEX now" })).toBe(true);
    expect(matches("body", "contains", "facebook admin", { text: "the facebook-admin team" })).toBe(true);
    expect(matches("body", "contains", "facebook admin", { text: "facebook administrators" })).toBe(false);
    expect(matches("sender_address", "contains", "sex", { address: "kim@essex.example" })).toBe(true);
  });

  test("matches pattern: * any run, ? any one, the whole value", () => {
    expect(matches("sender_address", "pattern", "*@*.spam.example", { address: "kim@m2.spam.example" })).toBe(true);
    expect(matches("sender_address", "pattern", "*@*.spam.example", { address: "kim@spam.example" })).toBe(false);
    expect(matches("subject", "pattern", "you won ?? dollars*", { subject: "You WON 50 dollars today" })).toBe(true);
    expect(matches("subject", "pattern", "you won", { subject: "you won 50" })).toBe(false);
    // Regex characters are themselves.
    expect(matches("subject", "pattern", "a.c(d)+", { subject: "a.c(d)+" })).toBe(true);
    expect(matches("subject", "pattern", "a.c", { subject: "abc" })).toBe(false);
  });

  test("a pattern never takes long, however many stars", () => {
    const started = performance.now();
    expect(matchesPattern(`${"*a".repeat(50)}b`, "a".repeat(10_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

test("a rule in words, and two rules that compare the same are one", () => {
  expect(describeSpamRule({ field: "subject_or_body", matcher: "contains", value: "facebook admin" })).toBe("Subject or body contains facebook admin");
  expect(spamRuleKey({ field: "subject", matcher: "contains", value: "Facebook-Admin!" })).toBe(spamRuleKey({ field: "subject", matcher: "contains", value: "facebook admin" }));
  expect(spamRuleKey({ field: "subject", matcher: "is", value: "Facebook-Admin" })).not.toBe(spamRuleKey({ field: "subject", matcher: "is", value: "facebook admin" }));
});
