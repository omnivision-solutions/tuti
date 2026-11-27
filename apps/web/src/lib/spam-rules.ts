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

/** Who a rule files: everyone, or only those the trust check doesn't vouch for. */
export const SPAM_RULE_AUDIENCES = { everyone: "Everyone", strangers: "Strangers only" } as const;

export type SpamRuleField = keyof typeof SPAM_RULE_FIELDS;
export type SpamRuleAudience = keyof typeof SPAM_RULE_AUDIENCES;
export const SPAM_RULE_AUDIENCE_KEYS = Object.keys(SPAM_RULE_AUDIENCES) as [SpamRuleAudience, ...SpamRuleAudience[]];
export type SpamRuleMatcher = keyof typeof SPAM_RULE_MATCHERS;
export type SpamRule = { field: SpamRuleField; matcher: SpamRuleMatcher; value: string; appliesTo?: SpamRuleAudience };

export const SPAM_RULE_FIELD_KEYS = Object.keys(SPAM_RULE_FIELDS) as [SpamRuleField, ...SpamRuleField[]];
export const SPAM_RULE_MATCHER_KEYS = Object.keys(SPAM_RULE_MATCHERS) as [SpamRuleMatcher, ...SpamRuleMatcher[]];

/** Rules on who sent it, which go by a proven address as the team's lists do; the rest are on what it says. */
export const isSenderRule = (rule: { field: string }) => rule.field === "sender_domain" || rule.field === "sender_address";

/** Fields whose "contains" matches whole words ("sex" isn't in "Essex"). */
const WORDS = new Set<string>(["subject", "body", "subject_or_body"]);

/** A rule in words: "Sender domain is spam.example", and "(strangers only)" after one that is. */
export const describeSpamRule = (rule: { field: string; matcher: string; value: string; appliesTo?: string }) =>
  `${SPAM_RULE_FIELDS[rule.field as SpamRuleField]} ${SPAM_RULE_MATCHERS[rule.matcher as SpamRuleMatcher]} ${rule.value}${rule.appliesTo === "strangers" ? " (strangers only)" : ""}`;

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
    // A star first: it's never a literal, even facing a "*" in the text.
    if (i < p.length && p[i] === "*") {
      star = i++;
      from = j;
    } else if (i < p.length && (p[i] === "?" || p[i] === t[j])) {
      i++;
      j++;
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
  `${rule.appliesTo ?? "everyone"} ${rule.field} ${rule.matcher} ${rule.matcher === "contains" && WORDS.has(rule.field) ? matchText(rule.value) : fold(rule.value)}`;

/** What a new conversation shows the rules: each field's text, null where it has none. */
export type SpamRuleInput = { domain?: string | null; address?: string | null; name?: string | null; subject?: string | null; text?: string | null; sentTo?: string[] };

/**
 * How much of each text the rules read. ponytail: a body's end past it isn't seen ("ends with" on a very long message);
 * read its last characters too if that matters.
 */
export const SPAM_RULE_TEXT_CHARS = 10_000;

function matchesOne(rule: SpamRule, text: string, fold: (text: string) => string, words: (text: string) => string): boolean {
  if (rule.matcher === "contains" && WORDS.has(rule.field)) {
    const value = words(rule.value);
    return value !== "" && ` ${words(text)} `.includes(` ${value} `);
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

/**
 * A test of rules against a conversation's fields (any of them, for "Subject or body" and "Sent to"): each text is cut
 * to `SPAM_RULE_TEXT_CHARS` and folded once, however many rules read it.
 */
export function spamRuleMatcher(input: SpamRuleInput): (rule: SpamRule) => boolean {
  const cut = (text: string | null | undefined) => text?.slice(0, SPAM_RULE_TEXT_CHARS) || null;
  const fields: Record<SpamRuleField, (string | null)[]> = {
    sender_domain: [cut(input.domain)],
    sender_address: [cut(input.address)],
    sender_name: [cut(input.name)],
    subject: [cut(input.subject)],
    body: [cut(input.text)],
    subject_or_body: [cut(input.subject), cut(input.text)],
    sent_to: (input.sentTo ?? []).map(cut),
  };
  const once = (fn: (text: string) => string) => {
    const done = new Map<string, string>();
    return (text: string) => done.get(text) ?? done.set(text, fn(text)).get(text)!;
  };
  const folded = once(fold);
  const words = once(matchText);
  return (rule) => (fields[rule.field as SpamRuleField] ?? []).some((text) => !!text && matchesOne(rule, text, folded, words));
}

/** Whether a rule matches a conversation's fields. */
export const spamRuleMatches = (rule: SpamRule, input: SpamRuleInput) => spamRuleMatcher(input)(rule);
