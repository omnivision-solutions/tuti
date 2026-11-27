import { prisma } from "@tuti/db";
import { getDomain } from "tldts";
import { z } from "zod";

import { matchText } from "@/lib/match-text";
import { SPAM_REASON_KEYS, spamPassedWhy, spamWhy } from "@/lib/spam-reasons";
import { SPAM_RULE_FIELD_KEYS, SPAM_RULE_FIELDS, SPAM_RULE_MATCHER_KEYS, SPAM_RULE_MATCHERS, type SpamRuleAudience, type SpamRuleField, type SpamRuleMatcher, SPAM_RULE_AUDIENCE_KEYS, spamRuleValue } from "@/lib/spam-rules";

import { userWithAddress } from "../inbound";
import { addSpamRule, allowSender, blockableDomain, lockSpamRules, spamVerdict } from "../spam";
import { MAX_SPAM_GUIDANCE, spamModelsOn } from "../spam-models";
import { emailAddress } from "./assistant";
import { defineOperation, OperationError } from "./define";

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2 and W2b): the spam filter's block rules (`spam_rule`), its allowed
 * list (`spam_sender` rows without a conversation, an owner's or admin's), its guidance for the models (checks 6 and 7,
 * W3), and trying a message against the filter.
 */

export const MAX_SPAM_RULES = 500;
export const MAX_SPAM_RULE_VALUE = 200;
/** The allowed list. */
export const MAX_SPAM_SENDERS = 500;

export type SpamRuleRow = { id: string; field: SpamRuleField; matcher: SpamRuleMatcher; value: string; appliesTo: SpamRuleAudience; fromReport: boolean };

/** `guidance` only where the server has a model for the filter: elsewhere nothing reads it. */
export type SpamSettings = { rules: SpamRuleRow[]; allowed: string[]; guidance?: string };

/** A project's rules (newest first), allowed list (alphabetical) and guidance, as the page and the API read them. */
export async function spamSettings(projectId: string): Promise<SpamSettings> {
  const [rules, allowed, { spamGuidance }] = await Promise.all([
    prisma.spamRule.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true, field: true, matcher: true, value: true, appliesTo: true, fromReport: true } }),
    prisma.spamSender.findMany({ where: { projectId, conversationId: null, blocked: false }, orderBy: { sender: "asc" }, select: { sender: true } }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { spamGuidance: true } }),
  ]);
  return { rules: rules as SpamRuleRow[], allowed: allowed.map((row) => row.sender), ...(spamModelsOn() && { guidance: spamGuidance }) };
}

const ENTRY = "Enter an address or a domain, like kim@acme.example or acme.example";

/** A domain anyone could register under or not at all ("com", "co.uk", "acme"): no entry or rule. */
const isDomain = (entry: string) => /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(entry) && !!getDomain(entry, { allowPrivateDomains: true });

/** An allowed list's entry: an address, or a domain ("@acme.example" is read as one), lowercase. */
const sender = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, ENTRY)
  .transform((entry) => entry.replace(/^@/, ""))
  .refine((entry) => (entry.includes("@") ? emailAddress.safeParse(entry).success : isDomain(entry)), ENTRY);

const senders = (what: string) => z.array(sender).max(100, "Send up to 100 at a time").optional().describe(what);

/** What a rule's value must be: said on the page under the field. */
function ruleProblem(field: SpamRuleField, matcher: SpamRuleMatcher, value: string): string | null {
  if (matcher === "is" && field === "sender_domain") {
    if (!isDomain(value)) {
      return "Enter a domain, like acme.example";
    }
    // Mark as spam never offers one either.
    return blockableDomain(value) ? null : `Anyone can get an address at ${value}, so it isn't blocked: block its addresses`;
  }
  if (matcher === "is" && (field === "sender_address" || field === "sent_to")) {
    return emailAddress.safeParse(value).success ? null : "Enter an address, like kim@acme.example";
  }
  if (matcher === "pattern") {
    return /[^*?\s]/.test(value) ? null : "Add something besides * and ?";
  }
  if (matcher === "contains" && ["subject", "body", "subject_or_body"].includes(field)) {
    return matchText(value) ? null : "Add a word";
  }
  return null;
}

const rule = z
  .object({
    field: z.enum(SPAM_RULE_FIELD_KEYS).describe(`What it looks at: ${SPAM_RULE_FIELD_KEYS.map((key) => `${key} (${SPAM_RULE_FIELDS[key].toLowerCase()})`).join(", ")}. sender_domain and sender_address go by a proven sender (never an address a signed-out visitor typed). sent_to is the To and Cc of an email`),
    matcher: z
      .enum(SPAM_RULE_MATCHER_KEYS)
      .describe(`How, ignoring case: ${SPAM_RULE_MATCHER_KEYS.map((key) => `${key} (${SPAM_RULE_MATCHERS[key]})`).join(", ")}. A sender_domain that "is" a domain is its subdomains too; "contains" on the subject or body matches whole words; a pattern has * (any characters) and ? (any one), never a regex`),
    appliesTo: z
      .enum(SPAM_RULE_AUDIENCE_KEYS)
      .default("everyone")
      .describe("Who it files: everyone (whoever they are, marked Not spam or not; only an allowed address, or an owner's or admin's Not spam, is an exception to a rule on the domain), or strangers (never one of the project's users, a teammate or someone the team has replied to)"),
    value: z.string().trim().min(1, "Enter a value").max(MAX_SPAM_RULE_VALUE, `Keep it under ${MAX_SPAM_RULE_VALUE} characters`).describe("What it compares with"),
  })
  .transform((input, ctx) => {
    const value = spamRuleValue(input.field, input.value);
    // "@" alone is no domain once its "@" goes: a rule with nothing in it would match everyone.
    const problem = value ? ruleProblem(input.field, input.matcher, value) : "Enter a value";
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
      return z.NEVER;
    }
    return { ...input, value };
  })
  .meta({ examples: [{ field: "subject_or_body", matcher: "contains", value: "facebook admin" }] });

const settingsOutput = z
  .object({
    rules: z
      .array(
        z.object({
          id: z.string().describe("The rule's ID, to remove it"),
          field: z.enum(SPAM_RULE_FIELD_KEYS).describe("What it looks at"),
          matcher: z.enum(SPAM_RULE_MATCHER_KEYS).describe("How it compares, ignoring case"),
          value: z.string().describe("What it compares with"),
          appliesTo: z.enum(SPAM_RULE_AUDIENCE_KEYS).describe("Who it files: everyone, or strangers only"),
          fromReport: z.boolean().describe("Whether marking a conversation as spam put it there"),
        }),
      )
      .describe("The block rules, newest first: a new conversation one matches goes to Spam")
      .meta({ examples: [[{ id: "cm1ruleexample", field: "sender_domain", matcher: "is", value: "spam.example", appliesTo: "everyone", fromReport: false }]] }),
    allowed: z
      .array(z.string())
      .describe("The allowed list, in alphabetical order: addresses, and domains (each for its subdomains too). An address beats the rules on its domain, and a domain a less exact domain's; an address (not a domain) also skips the hourly limit on new conversations by email")
      .meta({ examples: [["forms@acme.example"]] }),
    guidance: z
      .string()
      .optional()
      .describe("The team's guidance for the AI spam check, in its own words: what is and isn't spam for this team. Empty when there's none, and then the AI isn't asked; left out on a server without a model for the filter")
      .meta({ examples: ["Agencies offering SEO or design work are spam; questions about our API are not"] }),
  })
  .meta({ id: "SpamSettings", description: "What the team told the spam filter: its block rules, who's allowed and its guidance for the AI" });

export const getSpamSettings = defineOperation({
  name: "spam.get",
  title: "Get the spam filter's rules",
  summary: "Get the spam filter's block rules, its allowed list and the team's guidance for the AI spam check",
  method: "GET",
  path: "/spam",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: settingsOutput.describe("The spam filter's rules, allowed list and guidance"),
  run: ({ projectId }) => spamSettings(projectId),
});

export const updateSpamSettings = defineOperation({
  name: "spam.update",
  title: "Update the spam filter",
  summary:
    "Add or remove the spam filter's block rules, put addresses and domains on its allowed list or take them off, and set the team's guidance for the AI spam check. A rule the same as one there already isn't added again",
  method: "PATCH",
  path: "/spam",
  scope: "write",
  access: "admin",
  errors: [404, 409],
  input: z.object({
    addRules: z.array(rule).max(100, "Send up to 100 at a time").optional().describe(`Block rules to add; the project holds ${MAX_SPAM_RULES}`),
    removeRules: z.array(z.string()).max(100, "Send up to 100 at a time").optional().describe("The IDs of block rules to remove; one that isn't there is refused (404), removing none"),
    block: senders("Addresses and domains to block: each a rule that the sender address or domain is it (one on the allowed list comes off). A blocked address's rule decides before every mark on its sender's conversations; an entry for a domain is for its subdomains too. Not a domain anyone can get an address at, like gmail.com: block its addresses"),
    allow: senders("Addresses and domains to put on the allowed list (a rule that the sender address or domain is it is removed)"),
    remove: z
      // Spelled as block and allow take them: "@acme.example" is the domain.
      .array(z.string().trim().toLowerCase().max(320).transform((entry) => entry.replace(/^@/, "")))
      .max(100, "Send up to 100 at a time")
      .optional()
      .describe("Addresses and domains to take off the allowed list, or whose rule that the sender address or domain is it to remove"),
    guidance: z
      .string()
      .trim()
      .max(MAX_SPAM_GUIDANCE, `Keep the guidance under ${MAX_SPAM_GUIDANCE} characters`)
      .optional()
      .describe(
        `The team's guidance for the AI spam check, up to ${MAX_SPAM_GUIDANCE} characters: what is and isn't spam for this team, in its own words. The AI reads it with each new conversation no rule, list or trust decided, and isn't asked while it's empty. Empty to clear it`,
      ),
  }),
  output: settingsOutput.describe("The spam filter's rules, allowed list and guidance, as saved"),
  example: { addRules: [{ field: "sender_domain", matcher: "is", value: "spam.example" }], allow: ["forms@acme.example"] },
  run: async ({ projectId }, { addRules = [], removeRules = [], block = [], allow = [], remove = [], guidance }) => {
    const twice = [...block, ...allow].find((entry, i, all) => all.indexOf(entry) !== i) ?? remove.find((entry) => block.includes(entry) || allow.includes(entry));
    if (twice) {
      throw new OperationError(400, "invalid_input", `${twice} is there twice: block it, allow it or remove it`);
    }
    const free = block.find((entry) => !entry.includes("@") && !blockableDomain(entry));
    if (free) {
      throw new OperationError(400, "invalid_input", `Anyone can get an address at ${free}, so it isn't blocked: block its addresses`);
    }
    const blocks = block.map((entry) => ({ field: entry.includes("@") ? ("sender_address" as const) : ("sender_domain" as const), matcher: "is" as const, value: entry }));
    await prisma.$transaction(async (tx) => {
      await lockSpamRules(tx, projectId);
      // Only this project's: another's ID, or one already removed, is refused.
      const { count } = await tx.spamRule.deleteMany({ where: { projectId, id: { in: removeRules } } });
      if (count < new Set(removeRules).size) {
        throw new OperationError(404, "not_found", "That rule was already removed");
      }
      await tx.spamSender.deleteMany({ where: { projectId, conversationId: null, sender: { in: remove } } });
      await tx.spamRule.deleteMany({ where: { projectId, field: { in: ["sender_address", "sender_domain"] }, matcher: "is", value: { in: remove } } });
      for (const entry of allow) {
        await allowSender(tx, projectId, entry);
      }
      for (const added of [...blocks, ...addRules]) {
        await addSpamRule(tx, projectId, added);
      }
      // Only adding is refused past a limit: one that's over it (Mark as spam's "Also block" adds too) can still be cut.
      if (blocks.length + addRules.length > 0 && (await tx.spamRule.count({ where: { projectId } })) > MAX_SPAM_RULES) {
        throw new OperationError(409, "too_many", `The filter holds up to ${MAX_SPAM_RULES} rules: remove some first`);
      }
      if (allow.length > 0 && (await tx.spamSender.count({ where: { projectId, conversationId: null, blocked: false } })) > MAX_SPAM_SENDERS) {
        throw new OperationError(409, "too_many", `The allowed list holds up to ${MAX_SPAM_SENDERS} addresses and domains: remove some first`);
      }
      if (guidance !== undefined) {
        await tx.project.update({ where: { id: projectId }, data: { spamGuidance: guidance } });
      }
    });
    return spamSettings(projectId);
  },
});

export const trySpamFilter = defineOperation({
  name: "spam.try",
  title: "Try the spam filter",
  summary:
    "Check a message against the spam filter as an email from this sender that passed DMARC: whether it would go to Spam, and why. It changes nothing, and nothing is stored",
  method: "POST",
  path: "/spam/try",
  scope: "read",
  access: "admin",
  input: z.object({
    sender: emailAddress.describe("The address it would come from").meta({ examples: ["e2e-kim@spam.example"] }),
    subject: z.string().trim().max(200).default("").describe("Its subject"),
    text: z.string().trim().max(10_000).default("").describe("Its text"),
    name: z.string().trim().max(200).default("").describe("The sender's name, as in its From"),
    to: z.array(emailAddress).max(10).default([]).describe("The addresses it was sent to (its To and Cc)"),
  }),
  output: z.object({
    spam: z.boolean().describe("Whether it would go to Spam").meta({ examples: [true] }),
    reason: z
      .enum(SPAM_REASON_KEYS)
      .nullable()
      .describe("Why, as `spamReason` on a conversation; null when it wouldn't go to Spam")
      .meta({ examples: ["rule"] }),
    why: z.string().describe("The same in words: the reason it would go to Spam (the rule that matched, where one did), or what let it through").meta({ examples: ["your rule “subject or body contains facebook admin”"] }),
  }).describe("What the filter would do with the message"),
  example: { sender: "e2e-kim@spam.example", subject: "Facebook Admin", text: "Your page will be disabled." },
  run: async ({ projectId }, { sender: address, subject, text, name, to }) => {
    const userId = await userWithAddress(projectId, address);
    const verdict = await spamVerdict(prisma, { projectId, address, userId, proven: true, email: { sender: address, dmarc: "pass" }, subject, text, name: name || null, sentTo: to });
    return {
      spam: verdict.spam,
      reason: verdict.reason,
      // The rule that matched, where one did, even one a teammate's page names by its address or domain.
      why: verdict.phrase ? `your rule “${verdict.phrase.charAt(0).toLowerCase()}${verdict.phrase.slice(1)}”` : verdict.spam ? spamWhy(verdict.reason)! : spamPassedWhy(verdict.check),
    };
  },
});
