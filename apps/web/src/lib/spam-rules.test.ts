import { describe, expect, test } from "vitest";

import { describeSpamRule, matchesPattern, PATTERN_STEPS, SPAM_RULE_TEXT_CHARS, type SpamRule, type SpamRuleInput, spamRuleKey, spamRuleMatcher, spamRuleMatches, spamRuleValue } from "./spam-rules";

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
    // A star in the text is no reason to take the pattern's as a literal.
    expect(matches("subject", "pattern", "*offer*", { subject: "* special offer" })).toBe(true);
    expect(matches("subject", "pattern", "you won", { subject: "you won 50" })).toBe(false);
    // Regex characters are themselves.
    expect(matches("subject", "pattern", "a.c(d)+", { subject: "a.c(d)+" })).toBe(true);
    expect(matches("subject", "pattern", "a.c", { subject: "abc" })).toBe(false);
  });

  test("a pattern with many stars against a long text answers (a regex would backtrack for ever)", () => {
    expect(matchesPattern(`${"*a".repeat(50)}b`, "a".repeat(10_000))).toBe(false);
    expect(matchesPattern(`${"*a".repeat(50)}*`, "a".repeat(10_000))).toBe(true);
  });
});

test("a value as kept: addresses and domains lowercase, a domain's @ dropped, text as written", () => {
  expect(spamRuleValue("sender_domain", " @Spam.Example ")).toBe("spam.example");
  expect(spamRuleValue("sent_to", "Sales@Acme.example")).toBe("sales@acme.example");
  expect(spamRuleValue("subject", " Facebook Admin ")).toBe("Facebook Admin");
});

test("a rule in words, and two rules that compare the same are one", () => {
  expect(describeSpamRule({ field: "subject_or_body", matcher: "contains", value: "facebook admin" })).toBe("Subject or body contains facebook admin");
  expect(describeSpamRule({ field: "subject", matcher: "is", value: "hi", appliesTo: "strangers" })).toBe("Subject is hi (strangers only)");
  // Everyone and Strangers only are two rules.
  expect(spamRuleKey({ field: "subject", matcher: "is", value: "hi", appliesTo: "strangers" })).not.toBe(spamRuleKey({ field: "subject", matcher: "is", value: "hi" }));
  expect(spamRuleKey({ field: "subject", matcher: "contains", value: "Facebook-Admin!" })).toBe(spamRuleKey({ field: "subject", matcher: "contains", value: "facebook admin" }));
  expect(spamRuleKey({ field: "subject", matcher: "is", value: "Facebook-Admin" })).not.toBe(spamRuleKey({ field: "subject", matcher: "is", value: "facebook admin" }));
});

test("each pattern has its own budget: padding can't switch other rules off, and a pathological pattern stops at its own limit alone", () => {
  // A padded body of the longest length the rules read, almost matching every rule.
  const text = `${"facebook admi ".repeat(714)}giveaway`.slice(-SPAM_RULE_TEXT_CHARS);
  const matcher = spamRuleMatcher({ text });
  // 499 ordinary patterns that each scan the whole body and don't match, then one that does: it still matches.
  const misses = Array.from({ length: 499 }, (_, i) => ({ field: "body" as const, matcher: "pattern" as const, value: `*facebook admin ${i}*` }));
  expect([...misses, { field: "body" as const, matcher: "pattern" as const, value: "*giveaway" }].map(matcher).at(-1)).toBe(true);
  // An ordinary pattern's full scan of that body stays well within its budget.
  const ordinary = { left: PATTERN_STEPS };
  expect(matchesPattern("*facebook admin 7*", text, ordinary)).toBe(false);
  expect(PATTERN_STEPS - ordinary.left).toBeLessThan(PATTERN_STEPS / 2);
  // A pathological one (a long segment against text built to almost match it) stops at exactly its own limit…
  const worst = { left: PATTERN_STEPS };
  expect(matchesPattern(`*${"a".repeat(197)}b`, "a".repeat(SPAM_RULE_TEXT_CHARS), worst)).toBe(false);
  expect(worst.left).toBe(0);
  // …and the next rule on the same message still has its own.
  const padded = spamRuleMatcher({ text: `${"a".repeat(SPAM_RULE_TEXT_CHARS - 4)}spam` });
  expect([`*${"a".repeat(197)}b`, "*spam"].map((value) => padded({ field: "body", matcher: "pattern", value }))).toEqual([false, true]);
});
