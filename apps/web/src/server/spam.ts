import type { ConversationOrigin, Prisma } from "@tuti/db";
import { getDomain } from "tldts";

import { NEW_BY_EMAIL_PER_HOUR, type SpamReason } from "@/lib/spam-reasons";
import { describeSpamRule, isSenderRule, type SpamRule, spamRuleKey, spamRuleMatcher } from "@/lib/spam-rules";

import { OperationError } from "./operations/define";
import { spamModelsOn } from "./spam-models";

/**
 * The spam filter (docs/plan.md, Inbox automation, "The spam filter"): an ordered list of checks a new conversation from
 * a user goes through where it starts (an email, the widget, "Ask a person"), the first with an answer deciding. One the
 * team creates over the API is its own act and skips it. Also here: what a teammate's Mark as spam and Not spam teach it.
 */

type Db = Prisma.TransactionClient;

/** A user starting a conversation, as the filter sees them. */
export type Arrival = {
  projectId: string;
  /**
   * Their address, lowercase, where the team's decisions and trust go by it: not mail that failed DMARC (a forged From
   * would walk past that check), nor an address a signed-out visitor typed or the API gave, which proves nothing. Null then.
   */
  address: string | null;
  /** Who Tuti knows them as: the account they're signed in with, or the one their mail was matched to. */
  userId: string | null;
  /** They're signed in, or their mail passed DMARC: only then is one of the project's own users trusted as one. */
  proven: boolean;
  /** By email: its From address, and what the receiver's DMARC check said. */
  email?: { sender: string; dmarc: string };
  /** Their first message, for the team's rules on what it says: its subject, where it came with one, and its text. */
  subject?: string | null;
  text?: string;
  /** The name they go by: an email's From name, or the signed-in account's. */
  name?: string | null;
  /** By email: the addresses it was sent to (its To and Cc). */
  sentTo?: string[];
};

/**
 * Whether an email's From address is taken as its sender, by what the receiver's DMARC check said (`inbound_email.dmarc`):
 * not where it failed, nor where the mail named more than one From ("unproven", server/inbound.ts), when a pass may be
 * another address's. A domain with no DMARC record counts: nothing tells its real mail from a forgery today either.
 */
export const senderCounts = (dmarc: string) => dmarc !== "fail" && dmarc !== "unproven";

type Answer = { spam: true; reason: SpamReason; /** The block rule that matched, in words. */ phrase?: string } | { spam: false; /** No later check is asked, not even one that counts everyone's. */ sparesAll?: boolean };

type Check = {
  key: string;
  /** Asked even after an earlier check let the message through: an allow or trust doesn't spare it. */
  whoeverSent?: true;
  check: (db: Db, arrival: Arrival) => Promise<Answer | null> | Answer | null;
};

/** A domain and the domains above it, the most exact first: an entry for a domain is for its subdomains too. */
function domainsOf(address: string) {
  const labels = address.slice(address.lastIndexOf("@") + 1).split(".");
  return labels.map((_, i) => labels.slice(i).join("."));
}

type Rule = SpamRule & { id: string };

/** The team's block rules, oldest first. */
const rulesOf = (db: Db, projectId: string) =>
  db.spamRule.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, field: true, matcher: true, value: true, appliesTo: true } }) as Promise<Rule[]>;

/**
 * What the team decided of an address: its allowed entry, a "Sender address is" rule on it (`blockedAddress`), and the
 * most exact entry for its domain (an allowed domain, or a "Sender domain is" rule, its subdomains too), else another
 * rule on the domain that matches it.
 */
async function listed(db: Db, projectId: string, address: string, rules?: Rule[]) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const [allowed, all] = await Promise.all([
    db.spamSender.findMany({ where: { projectId, conversationId: null, blocked: false, sender: { in: [address, ...domainsOf(address)] } } }),
    rules ?? rulesOf(db, projectId),
  ]);
  const matches = spamRuleMatcher({ address, domain });
  const domainRules = all.filter((rule) => rule.field === "sender_domain" && matches(rule));
  const entries = [
    ...allowed.filter((row) => row.sender !== address).map((row) => ({ sender: row.sender, blocked: false as const, rule: null })),
    ...domainRules.filter((rule) => rule.matcher === "is").map((rule) => ({ sender: rule.value, blocked: true as const, rule })),
  ].sort((a, b) => b.sender.length - a.sender.length || Number(b.blocked) - Number(a.blocked));
  return {
    allowedAddress: allowed.find((row) => row.sender === address) ?? null,
    blockedAddress: all.find((rule) => rule.field === "sender_address" && rule.matcher === "is" && matches(rule)) ?? null,
    domain: entries[0] ?? (domainRules[0] ? { sender: domain, blocked: true as const, rule: domainRules[0] } : null),
  };
}

/** A rule's answer: an "is" rule on the sender says so as the lists did; any other is a rule. */
const ruleAnswer = (rule: Rule): Answer => ({
  spam: true,
  reason: rule.matcher !== "is" ? "rule" : rule.field === "sender_address" ? "blocked_address" : rule.field === "sender_domain" ? "blocked_domain" : "rule",
  phrase: describeSpamRule(rule),
});

/**
 * Check 1, the team's decisions. First the block rules but those on the domain, for everyone, whoever they are or
 * whatever was decided about them: those on what it says always, those on the address where it's proven. Then, the
 * most exact first: the address on the allowed list; the newest mark on one of its conversations; its domain's entry or
 * rule. So an allowed address, or an owner's or admin's Not spam, is an exception to a domain's rule and to nothing
 * else; a member's Not spam never counts against one, whenever it was made. An address an owner or admin put on the
 * allowed list spares every later check.
 */
async function decided(db: Db, arrival: Arrival): Promise<Answer | null> {
  const { projectId, address, subject, text, name, sentTo } = arrival;
  const all = await rulesOf(db, projectId);
  // A "Strangers only" rule files nobody the trust check vouches for (check 2, asked here only where one exists).
  const vouched = all.some((rule) => rule.appliesTo === "strangers") && !!(await trusted(db, arrival));
  const rules = vouched ? all.filter((rule) => rule.appliesTo !== "strangers") : all;
  const matches = spamRuleMatcher({ address, subject, text, name, sentTo });
  const everyone = rules.find((rule) => rule.field !== "sender_domain" && (rule.field !== "sender_address" || address) && matches(rule));
  if (everyone) {
    return ruleAnswer(everyone);
  }
  if (!address) {
    return null;
  }
  const on = await listed(db, projectId, address, rules);
  if (on.allowedAddress) {
    return { spam: false, sparesAll: on.allowedAddress.byAdmin };
  }
  const mark = await db.spamSender.findFirst({
    where: { projectId, sender: address, conversationId: { not: null }, ...(on.domain?.blocked && { OR: [{ blocked: true }, { byAdmin: true }] }) },
    orderBy: { decidedAt: "desc" },
    select: { blocked: true },
  });
  if (mark) {
    return mark.blocked ? { spam: true, reason: "marked_sender" } : { spam: false };
  }
  if (on.domain) {
    return on.domain.rule ? ruleAnswer(on.domain.rule) : { spam: false };
  }
  return null;
}

/**
 * Check 2, trusted: one of the project's own users (someone its app vouched for, by its sign-in or users.sync, and only
 * where they're signed in or their mail passed DMARC), a teammate, or someone the team has replied to. A Tuti account
 * with a verified address isn't trusted by that alone: anyone can make one.
 */
async function trusted(db: Db, { projectId, address, userId, proven }: Arrival): Promise<Answer | null> {
  if (!address && !userId) {
    return null;
  }
  const ownUser =
    proven && (await db.ssoIdentity.findFirst({ where: { projectId, OR: [...(userId ? [{ userId }] : []), ...(address ? [{ email: address }] : [])] }, select: { id: true } }));
  const teammate =
    ownUser ||
    (await db.teamMember.findFirst({ where: { projectId, OR: [...(userId ? [{ userId }] : []), ...(address ? [{ user: { email: address } }] : [])] }, select: { id: true } }));
  const repliedTo =
    teammate ||
    (await db.conversation.findFirst({
      where: {
        projectId,
        // Theirs, or with their address alone: never one where a signed-out visitor typed it.
        OR: [...(userId ? [{ userId }] : []), ...(address ? [{ userId: null, visitorHash: null, email: address }] : [])],
        messages: { some: { author: "TEAM", note: false } },
      },
      select: { id: true },
    }));
  return repliedTo ? { spam: false } : null;
}

/**
 * Check 4: too many new conversations by email from one address in an hour. Counted from the emails that started them,
 * so never one a signed-out visitor typed the address in, nor mail that failed DMARC (filed by check 3 already) or named
 * a second From: nobody can use up a real sender's count with any of them. Mail naming a second From is counted with
 * its own kind too, by its first address.
 */
async function flood(db: Db, { projectId, email }: Arrival): Promise<Answer | null> {
  if (!email?.sender) {
    return null;
  }
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  // The email that started a conversation was stored before it; one that joined it later (a reply) came after.
  const [{ started }] = await db.$queryRaw<[{ started: number }]>`
    SELECT count(*)::int AS started FROM inbound_email e JOIN conversation c ON c.id = e."conversationId"
    WHERE e."projectId" = ${projectId} AND e.sender = ${email.sender} AND e."createdAt" > ${hourAgo}
      AND e.dmarc <> 'fail' AND (e.dmarc <> 'unproven' OR ${!senderCounts(email.dmarc)})
      AND c.origin = 'EMAIL' AND c."createdAt" > ${hourAgo} AND e."createdAt" <= c."createdAt"`;
  return started >= NEW_BY_EMAIL_PER_HOUR ? { spam: true, reason: "flood" } : null;
}

/** The checks, in order. The models (6, 7) go after these, once the request has answered (server/spam-models.ts). */
export const SPAM_CHECKS: Check[] = [
  { key: "decisions", check: decided },
  { key: "trusted", check: trusted },
  // Today's rule: mail that failed DMARC, whatever lists its address is on (checks 1 and 2 never saw it).
  { key: "dmarc", check: (_db, { email }) => (email?.dmarc === "fail" ? { spam: true, reason: "dmarc_failed" } : null) },
  { key: "flood", whoeverSent: true, check: flood },
];

/**
 * Runs the checks on a new conversation, in the transaction that starts it: the first with an answer decides, and says
 * which (`check`). An allow or trust only spares the checks after it that don't count everyone's (`whoeverSent`). One
 * that none decided, neither filed nor let through, is for the models (`askModels`) where this server has one.
 */
export async function spamVerdict(db: Db, arrival: Arrival): Promise<{ spam: boolean; reason: SpamReason | null; check: string | null; phrase?: string; askModels?: boolean }> {
  // The models are asked only where the team has said what spam is to it ("AI spam check"): without, nothing is.
  const askModels = async () =>
    spamModelsOn() && !!(await db.project.findUniqueOrThrow({ where: { id: arrival.projectId }, select: { spamGuidance: true } })).spamGuidance.trim();
  let passedBy: string | null = null;
  for (const { key, whoeverSent, check } of SPAM_CHECKS) {
    if (passedBy && !whoeverSent) {
      continue;
    }
    const answer = await check(db, arrival);
    if (answer?.spam) {
      return { spam: true, reason: answer.reason, check: key, ...(answer.phrase && { phrase: answer.phrase }) };
    }
    if (answer && !passedBy) {
      if (answer.sparesAll) {
        return { spam: false, reason: null, check: key };
      }
      passedBy = key;
    }
  }
  return { spam: false, reason: null, check: passedBy, ...(!passedBy && (await askModels()) && { askModels: true }) };
}

/**
 * The address the team's decisions about an account go by: the one the project's app gave for its user, or the account's
 * own once verified. None otherwise (an address nobody checked proves nothing, like one typed).
 */
async function addressOf(db: Db, projectId: string, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, deletedAt: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });
  if (!user || user.deletedAt) {
    return null;
  }
  if (user.ssoIdentity) {
    return user.ssoIdentity.projectId === projectId ? user.ssoIdentity.email : null;
  }
  return user.emailVerified ? user.email.toLowerCase() : null;
}

/**
 * Someone starting a conversation in the widget, on the portal or over the API ("Ask a person"): signed in (`userId`), or
 * nobody Tuti knows, whose typed address proves nothing.
 */
export async function arrivalOf(db: Db, projectId: string, userId: string | null): Promise<Arrival> {
  if (!userId) {
    return { projectId, userId, proven: false, address: null };
  }
  const [address, user] = await Promise.all([addressOf(db, projectId, userId), db.user.findUnique({ where: { id: userId }, select: { name: true } })]);
  return { projectId, userId, proven: true, address, name: user?.name ?? null };
}

type Marked = { id: string; projectId: string; origin: ConversationOrigin; userId: string | null; visitorHash: string | null; spam?: boolean; spamReason?: string | null; spamPhrase?: string | null };

/**
 * The address a mark on this conversation is a decision about: the one check 1 looked its sender up by. Null where that
 * check never applied, so marking a forgery doesn't block the real sender and unmarking one doesn't allow the next: mail
 * that failed DMARC or named a second From, an address a signed-out visitor typed or the API gave, an account whose
 * address nobody checked.
 */
export async function conversationSender(db: Db, conversation: Marked): Promise<string | null> {
  if (conversation.userId) {
    return addressOf(db, conversation.projectId, conversation.userId);
  }
  if (conversation.visitorHash || conversation.origin !== "EMAIL") {
    return null;
  }
  // The email that started it: the first received into it.
  const first = await db.inboundEmail.findFirst({
    where: { projectId: conversation.projectId, conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    select: { sender: true, dmarc: true },
  });
  return first && senderCounts(first.dmarc) && first.sender ? first.sender : null;
}

/** Where anyone can get an address: blocking one of these domains would block strangers to each other. Never offered. */
const FREE_MAIL_DOMAINS = new Set(
  `gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com yahoo.co.uk yahoo.co.jp yahoo.fr yahoo.de
  hotmail.co.uk hotmail.fr outlook.fr outlook.de icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net gmx.de
  web.de mail.com zoho.com zohomail.com yandex.com yandex.ru mail.ru fastmail.com fastmail.fm hey.com tutanota.com tuta.io qq.com 163.com
  126.com naver.com rediffmail.com`.split(/\s+/),
);

/**
 * The domain "Also block" offers for an address: its organisational domain by the Public Suffix List (mail.acme.example
 * is acme.example's; a host's customers, each under a suffix of their own, stay apart). None for a free-mail domain, or
 * an address without one.
 */
export function blockableDomain(address: string): string | null {
  const domain = getDomain(address.slice(address.lastIndexOf("@") + 1), { allowPrivateDomains: true });
  return domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : null;
}

/** Reasons a block rule gives: only with one of them on a conversation are its kept words (`spamPhrase`) a rule's. */
const RULE_REASONS = new Set(["rule", "blocked_address", "blocked_domain"]);

/**
 * The rule that filed a conversation, while the filter's reason is still on it and the rule is still there. A teammate's
 * mark clears the reason: words left from before are no rule's doing.
 */
async function ruleThatFiled(db: Db, projectId: string, reason: string | null | undefined, phrase: string | null | undefined): Promise<Rule | null> {
  return phrase && RULE_REASONS.has(reason ?? "") ? ((await rulesOf(db, projectId)).find((rule) => describeSpamRule(rule) === phrase) ?? null) : null;
}

/**
 * What marking this conversation would do beyond it, for the teammate looking (`admin`: an owner or admin, whose the
 * rules are): the domain Mark as spam offers to block too, the "Sender address is" rule Not spam would remove
 * (`unblocks`), and, in words, another rule that filed it, which Not spam offers to remove (`removesRule`).
 */
export async function spamChoices(db: Db, conversation: Marked, admin: boolean): Promise<{ blockDomain: string | null; unblocks: string | null; removesRule: string | null }> {
  const sender = admin ? await conversationSender(db, conversation) : null;
  const on = sender ? await listed(db, conversation.projectId, sender) : null;
  const filedBy = admin && conversation.spam ? await ruleThatFiled(db, conversation.projectId, conversation.spamReason, conversation.spamPhrase) : null;
  return {
    blockDomain: sender && !on?.domain?.blocked ? blockableDomain(sender) : null,
    unblocks: sender && on?.blockedAddress ? sender : null,
    removesRule: filedBy && filedBy.id !== on?.blockedAddress?.id ? describeSpamRule(filedBy) : null,
  };
}

/**
 * A teammate marked a conversation Spam or Not spam: where check 1 would apply to its sender, the sender's decision is
 * kept too, as the conversation's own mark (one per conversation, deleted with it; the newest on an address wins).
 * Returns what Not spam leaves behind, to say, so it never looks more lasting than it is:
 * - A "Sender address is" rule: an owner's or admin's Not spam removes it; a member's leaves it, and the rule beats their mark.
 * - A rule on its domain: an owner's or admin's Not spam is an exception for this sender; a member's isn't kept at all.
 * - Any other rule that filed it (`phrase`, its words): it still applies to everyone, and says so, unless an owner or
 *   admin removes it with Not spam (`removeRule`).
 * - `reason`, why the filter had filed it: the flood limit still applies, and mail that fails DMARC is still filed.
 */
export async function recordMark(
  db: Db,
  conversation: Marked,
  spam: boolean,
  admin: boolean,
  reason: string | null,
  { phrase = null, removeRule = false }: { phrase?: string | null; removeRule?: boolean } = {},
): Promise<string | undefined> {
  const notices: string[] = [];
  const filedBy = spam ? null : await ruleThatFiled(db, conversation.projectId, reason, phrase);
  if (removeRule) {
    if (!admin) {
      throw new OperationError(403, "forbidden", "Only project owners and admins can remove a rule");
    }
    if (!filedBy) {
      throw new OperationError(409, "no_rule", "That rule was already removed");
    }
    await db.spamRule.deleteMany({ where: { id: filedBy.id } });
  }
  const sender = await conversationSender(db, conversation);
  if (sender) {
    const on = spam ? null : await listed(db, conversation.projectId, sender);
    const mark = { sender, blocked: spam, byAdmin: admin, decidedAt: new Date() };
    let kept = true;
    if (on?.blockedAddress) {
      if (admin) {
        // Not `delete`: unblocked from another of their conversations at once, it's gone already, which is what was asked.
        await db.spamRule.deleteMany({ where: { id: on.blockedAddress.id } });
      }
      notices.push(admin ? `${sender} is unblocked.` : `${sender} stays blocked: an owner or admin can unblock it.`);
    } else if (on?.domain?.rule && !on.allowedAddress) {
      // The rule on its domain, as said: a domain by its name, another rule in words.
      const blocker = on.domain.rule;
      const exact = blocker.matcher === "is";
      const name = exact ? blocker.value : `Your rule “${describeSpamRule(blocker)}”`;
      const stays = exact ? "stays blocked" : "still applies";
      kept = admin;
      notices.push(admin ? `${name} ${stays}. ${sender} is let through from now on.` : `${name} ${stays}: an owner or admin can let ${sender} through.`);
    }
    if (kept) {
      await db.spamSender.upsert({ where: { conversationId: conversation.id }, create: { ...mark, projectId: conversation.projectId, conversationId: conversation.id }, update: mark });
    } else {
      // Unmarked, and nothing more: the mark it had goes with that.
      await db.spamSender.deleteMany({ where: { conversationId: conversation.id } });
    }
  }
  // A rule on anything but the domain applies to everyone, Not spam or not: said, so the next one isn't a surprise.
  if (filedBy && filedBy.field !== "sender_domain" && !(filedBy.field === "sender_address" && filedBy.matcher === "is")) {
    const words = describeSpamRule(filedBy);
    notices.push(removeRule ? `Filed by your rule: ${words}. It's removed.` : `Filed by your rule: ${words}. It still applies${admin ? "" : ": an owner or admin can remove it"}.`);
  } else if (removeRule && filedBy) {
    notices.unshift(`Filed by your rule: ${describeSpamRule(filedBy)}. It's removed.`);
  }
  if (!spam && reason === "flood") {
    notices.push(`The hourly limit still applies: past ${NEW_BY_EMAIL_PER_HOUR} new conversations by email from one address in an hour, more go to Spam.`);
  }
  if (!spam && reason === "phrase" && !sender) {
    notices.push("Nothing is remembered about its sender: a message with one of your phrases still goes to Spam.");
  }
  if (!spam && reason === "dmarc_failed") {
    notices.push("Nothing is remembered about its sender: mail that fails DMARC still goes to Spam.");
  }
  return notices.join(" ") || undefined;
}

/**
 * "Also block <domain>", with Mark as spam: the sender's organisational domain goes on the blocked list, its subdomains
 * with it. Owners and admins only, as the lists are theirs; never a free-mail domain, nor for a sender check 1 doesn't
 * apply to. Returns the domain.
 */
export async function blockDomainOf(db: Db, conversation: Marked, admin: boolean): Promise<string> {
  if (!admin) {
    throw new OperationError(403, "forbidden", "Only project owners and admins can block a domain");
  }
  const sender = await conversationSender(db, conversation);
  const domain = sender && blockableDomain(sender);
  if (!domain) {
    throw new OperationError(
      409,
      "no_domain",
      sender ? "Anyone can get an address at this domain, so it isn't blocked: marking as spam blocks this address" : "This conversation's sender isn't proven, so there's no domain to block",
    );
  }
  await addSpamRule(db, conversation.projectId, { field: "sender_domain", matcher: "is", value: domain }, true);
  return domain;
}

/**
 * Held till the transaction ends: one change to a project's rules and allowed list at a time (Settings, the API, Mark as
 * spam's "Also block"), so none adds a rule another is adding, and two can't each fit under a limit.
 */
export const lockSpamRules = (db: Db, projectId: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(41, hashtext(${projectId}))`;

/**
 * A block rule, an owner's or admin's doing (`fromReport`: by marking a conversation as spam). One the same as a rule
 * there already (`spamRuleKey`) isn't added again. A "Sender address is" or "Sender domain is" rule takes the address or
 * domain off the allowed list: on one list at a time. Returns whether it was added.
 */
export async function addSpamRule(db: Db, projectId: string, rule: SpamRule, fromReport = false): Promise<boolean> {
  await lockSpamRules(db, projectId);
  const key = spamRuleKey(rule);
  const same = await db.spamRule.findMany({ where: { projectId, field: rule.field, matcher: rule.matcher }, select: { field: true, matcher: true, value: true, appliesTo: true } });
  if (same.some((other) => spamRuleKey(other as SpamRule) === key)) {
    return false;
  }
  await db.spamRule.create({ data: { projectId, ...rule, fromReport } });
  if (isSenderRule(rule) && rule.matcher === "is") {
    await db.spamSender.deleteMany({ where: { projectId, conversationId: null, sender: rule.value } });
  }
  return true;
}

/**
 * An address or a domain on the team's allowed list, an owner's or admin's doing, its "is" block rule removed. One entry
 * per address or domain (the partial unique index; a blocked row there is from before the block rules, and read no more).
 */
export async function allowSender(db: Db, projectId: string, sender: string) {
  await lockSpamRules(db, projectId);
  await db.spamRule.deleteMany({ where: { projectId, field: { in: ["sender_address", "sender_domain"] }, matcher: "is", value: sender } });
  await db.$executeRaw`
    INSERT INTO spam_sender (id, "projectId", sender, blocked, "byAdmin", "decidedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${sender}, false, true, ${new Date()})
    ON CONFLICT ("projectId", sender) WHERE "conversationId" IS NULL
    DO UPDATE SET blocked = EXCLUDED.blocked, "byAdmin" = true, "decidedAt" = EXCLUDED."decidedAt"`;
}
