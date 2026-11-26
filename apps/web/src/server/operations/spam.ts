import { prisma } from "@tuti/db";
import { getDomain } from "tldts";
import { z } from "zod";

import { SPAM_REASON_KEYS, spamWhy } from "@/lib/spam-reasons";

import { userWithAddress } from "../inbound";
import { blockableDomain, listSender, spamVerdict } from "../spam";
import { emailAddress, matchText } from "./assistant";
import { defineOperation, OperationError } from "./define";

/**
 * Settings → Spam (docs/plan.md, Inbox automation, W2): the spam filter's blocked and allowed lists (`spam_sender` rows
 * without a conversation, an owner's or admin's), the team's phrases (check 5), and trying a message against the filter.
 */

/** Both lists together. */
export const MAX_SPAM_SENDERS = 500;
export const MAX_SPAM_PHRASES = 50;
export const MAX_SPAM_PHRASE = 80;

export type SpamSettings = { blocked: string[]; allowed: string[]; phrases: string[] };

/** A project's lists and phrases, as the page and the API read them: each list in alphabetical order. */
export async function spamSettings(projectId: string): Promise<SpamSettings> {
  const [senders, { spamPhrases }] = await Promise.all([
    prisma.spamSender.findMany({ where: { projectId, conversationId: null }, orderBy: { sender: "asc" }, select: { sender: true, blocked: true } }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { spamPhrases: true } }),
  ]);
  const on = (blocked: boolean) => senders.filter((row) => row.blocked === blocked).map((row) => row.sender);
  return { blocked: on(true), allowed: on(false), phrases: spamPhrases };
}

const ENTRY = "Enter an address or a domain, like kim@acme.example or acme.example";

/**
 * A list's entry: an address, or a domain ("@acme.example" is read as one), lowercase. Not a suffix anyone registers
 * under ("com", "co.uk"), whose entry would be for everyone's mail.
 */
const sender = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, ENTRY)
  .transform((entry) => entry.replace(/^@/, ""))
  .refine((entry) => (entry.includes("@") ? emailAddress.safeParse(entry).success : /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(entry) && !!getDomain(entry, { allowPrivateDomains: true })), ENTRY);

const senders = (what: string) => z.array(sender).max(100, "Send up to 100 at a time").optional().describe(what);

const settingsOutput = z
  .object({
    blocked: z
      .array(z.string())
      .describe("The blocked list, in alphabetical order: addresses, and domains (each for its subdomains too). What they send goes to Spam")
      .meta({ examples: [["e2e-kim@spam.example", "spam.example"]] }),
    allowed: z
      .array(z.string())
      .describe(
        "The allowed list, in alphabetical order: addresses, and domains (each for its subdomains too). Their messages skip the phrases; an address (not a domain) also skips the hourly limit on new conversations by email",
      )
      .meta({ examples: [["forms@acme.example"]] }),
    phrases: z
      .array(z.string())
      .describe("The team's phrases: a new conversation whose subject or first message has one, as whole words in any case, goes to Spam")
      .meta({ examples: [["facebook admin"]] }),
  })
  .meta({ id: "SpamSettings", description: "What the team told the spam filter: who's blocked, who's allowed, and its phrases" });

export const getSpamSettings = defineOperation({
  name: "spam.get",
  title: "Get the spam filter's lists",
  summary: "Get the spam filter's blocked and allowed lists and the team's phrases",
  method: "GET",
  path: "/spam",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: settingsOutput.describe("The spam filter's lists and phrases"),
  run: ({ projectId }) => spamSettings(projectId),
});

export const updateSpamSettings = defineOperation({
  name: "spam.update",
  title: "Update the spam filter",
  summary:
    "Add addresses and domains to the spam filter's blocked or allowed list, take them off, and add or remove the team's phrases. A list's address decides before every mark on its sender's conversations, and a domain's entry is for its subdomains too",
  method: "PATCH",
  path: "/spam",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    block: senders("Addresses and domains to put on the blocked list (one on the allowed list moves). Not a domain anyone can get an address at, like gmail.com: block its addresses"),
    allow: senders("Addresses and domains to put on the allowed list (one on the blocked list moves)"),
    // As it is on the list, whatever that is: nothing there can't be taken off.
    remove: z
      // Spelled as block and allow take them: "@acme.example" is the domain.
      .array(z.string().trim().toLowerCase().max(320).transform((entry) => entry.replace(/^@/, "")))
      .max(100, "Send up to 100 at a time")
      .optional()
      .describe("Addresses and domains to take off whichever list they're on"),
    addPhrases: z
      .array(
        z
          .string()
          .trim()
          .max(MAX_SPAM_PHRASE, `Keep each phrase under ${MAX_SPAM_PHRASE} characters`)
          .refine((phrase) => matchText(phrase) !== "", "Each phrase needs a word in it"),
      )
      .max(MAX_SPAM_PHRASES, `Add up to ${MAX_SPAM_PHRASES} phrases`)
      .optional()
      .describe(
        `Phrases to add, each up to ${MAX_SPAM_PHRASE} characters; the list holds ${MAX_SPAM_PHRASES}. A new conversation whose subject or first message has one (as whole words, in any case) goes to Spam, unless its sender is allowed or trusted. One that matches the same text as a phrase already there ("Facebook admin", "facebook-admin") isn't added again`,
      ),
    removePhrases: z
      .array(z.string().trim().max(MAX_SPAM_PHRASE))
      .max(MAX_SPAM_PHRASES)
      .optional()
      .describe("Phrases to take out, however they're cased or punctuated"),
  }),
  output: settingsOutput.describe("The spam filter's lists and phrases, as saved"),
  example: { block: ["spam.example"], allow: ["forms@acme.example"], addPhrases: ["facebook admin"] },
  run: async ({ projectId }, { block = [], allow = [], remove = [], addPhrases = [], removePhrases = [] }) => {
    const twice = [...block, ...allow].find((entry, i, all) => all.indexOf(entry) !== i) ?? remove.find((entry) => block.includes(entry) || allow.includes(entry));
    if (twice) {
      throw new OperationError(400, "invalid_input", `${twice} is there twice: block it, allow it or remove it`);
    }
    const free = block.find((entry) => !entry.includes("@") && !blockableDomain(entry));
    if (free) {
      throw new OperationError(400, "invalid_input", `Anyone can get an address at ${free}, so it isn't blocked: block its addresses`);
    }
    await prisma.$transaction(async (tx) => {
      // The project's row is held, so two changes at once can't each fit under a limit, and neither's phrase is lost:
      // the phrases are read under it.
      const [{ phrases }] = await tx.$queryRaw<[{ phrases: string[] }]>`SELECT "spamPhrases" AS phrases FROM project WHERE id = ${projectId} FOR NO KEY UPDATE`;
      await tx.spamSender.deleteMany({ where: { projectId, conversationId: null, sender: { in: remove } } });
      for (const [entries, blocked] of [[block, true], [allow, false]] as const) {
        for (const entry of entries) {
          await listSender(tx, projectId, entry, blocked);
        }
      }
      // Only adding is refused past the limit: a list that's over it (Mark as spam's "Also block" adds too) can still be cut.
      if (block.length + allow.length > 0 && (await tx.spamSender.count({ where: { projectId, conversationId: null } })) > MAX_SPAM_SENDERS) {
        throw new OperationError(409, "too_many", `The lists hold up to ${MAX_SPAM_SENDERS} addresses and domains: remove some first`);
      }
      if (addPhrases.length + removePhrases.length > 0) {
        const gone = new Set(removePhrases.map(matchText));
        // One of each, however it's written ("Facebook admin" and "facebook  admin" match the same text): the first kept.
        const kept = [...phrases.filter((phrase) => !gone.has(matchText(phrase))), ...addPhrases].filter(
          (phrase, i, all) => all.findIndex((other) => matchText(other) === matchText(phrase)) === i,
        );
        if (addPhrases.length > 0 && kept.length > MAX_SPAM_PHRASES) {
          throw new OperationError(409, "too_many", `The list holds up to ${MAX_SPAM_PHRASES} phrases: remove some first`);
        }
        await tx.project.update({ where: { id: projectId }, data: { spamPhrases: kept } });
      }
    });
    return spamSettings(projectId);
  },
});

/** Why a message got through, by the check that let it (`spamVerdict`'s `check`). */
const PASSED = {
  decisions: "your lists and marks let this sender through",
  trusted: "this sender is trusted: one of your users, a teammate, or someone your team has replied to",
} as const;

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
  }),
  output: z.object({
    spam: z.boolean().describe("Whether it would go to Spam").meta({ examples: [true] }),
    reason: z
      .enum(SPAM_REASON_KEYS)
      .nullable()
      .describe("Why, as `spamReason` on a conversation; null when it wouldn't go to Spam")
      .meta({ examples: ["phrase"] }),
    why: z.string().describe("The same in words: the reason it would go to Spam, or what let it through").meta({ examples: ["it has your phrase “facebook admin”"] }),
  }).describe("What the filter would do with the message"),
  example: { sender: "e2e-kim@spam.example", subject: "Facebook Admin", text: "Your page will be disabled." },
  run: async ({ projectId }, { sender: address, subject, text }) => {
    const userId = await userWithAddress(projectId, address);
    const verdict = await spamVerdict(prisma, { projectId, address, userId, proven: true, email: { sender: address, dmarc: "pass" }, subject, text });
    return {
      spam: verdict.spam,
      reason: verdict.reason,
      why: verdict.spam ? spamWhy(verdict.reason, verdict.phrase)! : (PASSED[verdict.check as keyof typeof PASSED] ?? "no check filed it"),
    };
  },
});
