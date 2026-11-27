import { describe, expect, test } from "vitest";

import { describeSpamRule, matchesPattern, MAX_PATTERN, MAX_PATTERN_RULES, SPAM_RULE_TEXT_CHARS, type SpamRule, type SpamRuleInput, spamRuleKey, spamRuleMatcher, spamRuleMatches, spamRuleValue } from "./spam-rules";

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


describe("patterns, without backtracking", () => {
  const pattern = (value: string, text: string) => matches("subject", "pattern", value, { subject: text });

  test("anchors: no star is the whole text; a star at either end frees that end", () => {
    expect(pattern("offer", "offer")).toBe(true);
    expect(pattern("offer", "an offer")).toBe(false);
    expect(pattern("offer*", "offer inside")).toBe(true);
    expect(pattern("offer*", "an offer")).toBe(false);
    expect(pattern("*offer", "an offer")).toBe(true);
    expect(pattern("*offer", "offer inside")).toBe(false);
    expect(pattern("re:*offer", "RE: your offer")).toBe(true);
    expect(pattern("re:*offer", "re: offers")).toBe(false);
    // Case and look-alikes as everywhere: a fullwidth star is a star.
    expect(pattern("＊OFFER", "an offer")).toBe(true);
  });

  test("? is any one character, inside a segment and at either end", () => {
    expect(pattern("w?n", "win")).toBe(true);
    expect(pattern("w?n", "wn")).toBe(false);
    expect(pattern("*w?n *prize", "you won a prize")).toBe(true);
    expect(pattern("??", "ab")).toBe(true);
    expect(pattern("??", "abc")).toBe(false);
  });

  test("consecutive stars and empty segments are one star; a lone star is anything", () => {
    expect(pattern("a**b", "a to b")).toBe(true);
    expect(pattern("**", "anything")).toBe(true);
    expect(pattern("*", "")).toBe(false); // an empty subject is no text to match
    expect(matchesPattern("*", "")).toBe(true);
    expect(matchesPattern("a*", "a")).toBe(true);
    expect(matchesPattern("a*a", "a")).toBe(false); // the first and the last can't share a character
    expect(matchesPattern("ab*ba", "aba")).toBe(false);
    expect(matchesPattern("ab*ba", "abba")).toBe(true);
  });

  test("middle segments go left to right, each after the one before", () => {
    expect(pattern("*free*money*", "free easy money")).toBe(true);
    expect(pattern("*free*money*", "money for free")).toBe(false);
    expect(pattern("*a*b*c", "xaxbxc")).toBe(true);
    expect(pattern("*a*b*c", "xcxbxa")).toBe(false);
  });

  test("a crafted text against a many-star pattern answers", () => {
    const text = "a".repeat(SPAM_RULE_TEXT_CHARS);
    expect(matchesPattern("a*a*a*a*b", text)).toBe(false);
    expect(matchesPattern(`*${"a".repeat(MAX_PATTERN - 2)}b`, text)).toBe(false);
    expect(matchesPattern("a*a*a*a*a", text)).toBe(true);
  });

  test("a text is cut once folded: characters that fold into many can't take it past the cap", () => {
    // 1,204 characters as sent, over 11,000 once "ﷺ" (18 each) is folded: its end is past what the rules read.
    const text = `${"x".repeat(600)}${"ﷺ".repeat(600)}spam`;
    expect(matches("body", "starts_with", "xxx", { text })).toBe(true);
    expect(matches("body", "ends_with", "spam", { text })).toBe(false);
    expect(matches("body", "pattern", "*spam", { text })).toBe(false);
  });

  test("a padded body of the longest length through the most pattern rules a project holds still matches on the last rule", () => {
    const text = `${"facebook admi ".repeat(714)}giveaway`.slice(-SPAM_RULE_TEXT_CHARS);
    const matcher = spamRuleMatcher({ text });
    const misses = Array.from({ length: MAX_PATTERN_RULES - 1 }, (_, i) => ({ field: "body" as const, matcher: "pattern" as const, value: `*facebook admin ${i}*` }));
    expect([...misses, { field: "body" as const, matcher: "pattern" as const, value: "*giveaway" }].map(matcher)).toEqual([...misses.map(() => false), true]);
  });
});
