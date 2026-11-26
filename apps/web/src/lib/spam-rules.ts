import { matchText } from "./match-text";

/**
 * The spam filter's block rules (docs/plan.md, Inbox automation, W2b): a field of a new conversation, a matcher and a
 * value, every comparison ignoring case. Matched here, with nothing from the database, so the page and the server agree.
 */

export const SPAM_RULE_FIELDS = {
  sender_domain: "Sender domain",
  sender_address: "Sender address",
  sender_name: "Sender name",
  subject: "Subject",
  body: "Body",
  subject_or_body: "Subject or body",
  sent_to: "Sent to",
} as const;

export const SPAM_RULE_MATCHERS = {
  is: "is",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  pattern: "matches pattern",
} as const;

export type SpamRuleField = keyof typeof SPAM_RULE_FIELDS;
export type SpamRuleMatcher = keyof typeof SPAM_RULE_MATCHERS;
export type SpamRule = { field: SpamRuleField; matcher: SpamRuleMatcher; value: string };

export const SPAM_RULE_FIELD_KEYS = Object.keys(SPAM_RULE_FIELDS) as [SpamRuleField, ...SpamRuleField[]];
export const SPAM_RULE_MATCHER_KEYS = Object.keys(SPAM_RULE_MATCHERS) as [SpamRuleMatcher, ...SpamRuleMatcher[]];

/** Rules on who sent it, which go by a proven address as the team's lists do; the rest are on what it says. */
export const isSenderRule = (rule: { field: string }) => rule.field === "sender_domain" || rule.field === "sender_address";

/** Fields whose "contains" matches whole words ("sex" isn't in "Essex"). */
const WORDS = new Set<string>(["subject", "body", "subject_or_body"]);

/** A rule in words: "Sender domain is spam.example". */
export const describeSpamRule = (rule: { field: string; matcher: string; value: string }) =>
  `${SPAM_RULE_FIELDS[rule.field as SpamRuleField]} ${SPAM_RULE_MATCHERS[rule.matcher as SpamRuleMatcher]} ${rule.value}`;

/** A value as a rule keeps it: addresses and domains lowercase, and "@acme.example" the domain. */
export function spamRuleValue(field: SpamRuleField, value: string) {
  const trimmed = value.trim();
  const lower = field === "sender_domain" || field === "sender_address" || field === "sent_to" ? trimmed.toLowerCase() : trimmed;
  return field === "sender_domain" ? lower.replace(/^@/, "") : lower;
}

/** Lowercase, look-alikes folded, runs of space as one. */
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether `text` is all of `pattern`, where `*` is any run of characters and `?` any one: never a regex, which a team's
 * pattern could make take forever. Greedy with one step back to the last `*`, so at most the two lengths multiplied.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  const p = [...pattern];
  const t = [...text];
  let i = 0;
  let j = 0;
  let star = -1;
  let from = 0;
  while (j < t.length) {
    if (i < p.length && (p[i] === "?" || p[i] === t[j])) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      from = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++from;
    } else {
      return false;
    }
  }
  while (p[i] === "*") {
    i++;
  }
  return i === p.length;
}

/** The value a rule compares, as it's compared: two rules with the same key are the same rule. */
export const spamRuleKey = (rule: SpamRule) =>
  `${rule.field} ${rule.matcher} ${rule.matcher === "contains" && WORDS.has(rule.field) ? matchText(rule.value) : fold(rule.value)}`;

/** What a new conversation shows the rules: each field's text, null where it has none. */
export type SpamRuleInput = { domain?: string | null; address?: string | null; name?: string | null; subject?: string | null; text?: string | null; sentTo?: string[] };

function matchesOne(rule: SpamRule, text: string): boolean {
  if (rule.matcher === "contains" && WORDS.has(rule.field)) {
    const words = matchText(rule.value);
    return words !== "" && ` ${matchText(text)} `.includes(` ${words} `);
  }
  const value = fold(rule.value);
  const folded = fold(text);
  switch (rule.matcher) {
    case "is":
      // A domain's rule is for its subdomains too, as the lists' domains are.
      return folded === value || (rule.field === "sender_domain" && folded.endsWith(`.${value}`));
    case "contains":
      return folded.includes(value);
    case "starts_with":
      return folded.startsWith(value);
    case "ends_with":
      return folded.endsWith(value);
    case "pattern":
      return matchesPattern(value, folded);
  }
}

/** Whether a rule matches a conversation's field (any of them, for "Subject or body" and "Sent to"). */
export function spamRuleMatches(rule: SpamRule, input: SpamRuleInput): boolean {
  const texts: (string | null | undefined)[] = {
    sender_domain: [input.domain],
    sender_address: [input.address],
    sender_name: [input.name],
    subject: [input.subject],
    body: [input.text],
    subject_or_body: [input.subject, input.text],
    sent_to: input.sentTo ?? [],
  }[rule.field];
  return texts.some((text) => !!text && matchesOne(rule, text));
}
