import type { ConversationOrigin, Prisma } from "@tuti/db";
import { getDomain } from "tldts";

import { NEW_BY_EMAIL_PER_HOUR, type SpamReason } from "@/lib/spam-reasons";

import { offLimitsTopic } from "./operations/assistant";
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
  /** Their first message, for the team's phrases: its subject, where it came with one, and its text. */
  subject?: string | null;
  text?: string;
};

/**
 * Whether an email's From address is taken as its sender, by what the receiver's DMARC check said (`inbound_email.dmarc`):
 * not where it failed, nor where the mail named more than one From ("unproven", server/inbound.ts), when a pass may be
 * another address's. A domain with no DMARC record counts: nothing tells its real mail from a forgery today either.
 */
export const senderCounts = (dmarc: string) => dmarc !== "fail" && dmarc !== "unproven";

type Answer = { spam: true; reason: SpamReason; /** With "phrase": the one that matched. */ phrase?: string } | { spam: false; /** No later check is asked, not even one that counts everyone's. */ sparesAll?: boolean };

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

/** What the team's lists say of an address: its own entry, and the most exact entry for its domain. */
async function listed(db: Db, projectId: string, address: string) {
  const rows = await db.spamSender.findMany({ where: { projectId, conversationId: null, sender: { in: [address, ...domainsOf(address)] } } });
  return {
    address: rows.find((row) => row.sender === address) ?? null,
    domain: rows.filter((row) => row.sender !== address).sort((a, b) => b.sender.length - a.sender.length)[0] ?? null,
  };
}

/**
 * Check 1, the team's decisions, the most exact first: the address on a list; else the newest mark on one of its
 * conversations; else its domain on a list. A member's Not spam never counts against a blocked domain, whenever it was
 * made: only an owner's or admin's is an exception to one. An address on the allowed list spares every later check.
 */
async function decided(db: Db, { projectId, address }: Arrival): Promise<Answer | null> {
  if (!address) {
    return null;
  }
  const on = await listed(db, projectId, address);
  if (on.address) {
    return on.address.blocked ? { spam: true, reason: "blocked_address" } : { spam: false, sparesAll: on.address.byAdmin };
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
    return on.domain.blocked ? { spam: true, reason: "blocked_domain" } : { spam: false };
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

/**
 * Check 5, the team's phrases (Settings → Spam): one in the subject or the text of the first message, as whole words
 * whatever the case and accents ("facebook admin" matches "Facebook Admin!", not "facebook administrators"), as
 * off-limits topics are matched. Never across the two: a phrase is in one or the other.
 */
async function phrases(db: Db, { projectId, subject, text }: Arrival): Promise<Answer | null> {
  if (!subject && !text) {
    return null;
  }
  const { spamPhrases } = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { spamPhrases: true } });
  const phrase = offLimitsTopic(subject ?? "", spamPhrases) ?? offLimitsTopic(text ?? "", spamPhrases);
  return phrase ? { spam: true, reason: "phrase", phrase } : null;
}

/** The checks, in order. The models (6, 7) go after these, once the request has answered (server/spam-models.ts). */
export const SPAM_CHECKS: Check[] = [
  { key: "decisions", check: decided },
  { key: "trusted", check: trusted },
  // Today's rule: mail that failed DMARC, whatever lists its address is on (checks 1 and 2 never saw it).
  { key: "dmarc", check: (_db, { email }) => (email?.dmarc === "fail" ? { spam: true, reason: "dmarc_failed" } : null) },
  { key: "flood", whoeverSent: true, check: flood },
  // An allow or trust spares it: the team's own users may write "facebook admin".
  { key: "phrases", check: phrases },
];

/**
 * Runs the checks on a new conversation, in the transaction that starts it: the first with an answer decides, and says
 * which (`check`). An allow or trust only spares the checks after it that don't count everyone's (`whoeverSent`). One
 * that none decided, neither filed nor let through, is for the models (`askModels`) where this server has one.
 */
export async function spamVerdict(db: Db, arrival: Arrival): Promise<{ spam: boolean; reason: SpamReason | null; check: string | null; phrase?: string; askModels?: boolean }> {
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
  return { spam: false, reason: null, check: passedBy, ...(!passedBy && spamModelsOn() && { askModels: true }) };
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
  return { projectId, userId, proven: !!userId, address: userId ? await addressOf(db, projectId, userId) : null };
}

type Marked = { id: string; projectId: string; origin: ConversationOrigin; userId: string | null; visitorHash: string | null };

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

/**
 * What marking this conversation would do beyond it, for the teammate looking (`admin`: an owner or admin, whose the
 * lists are): the domain Mark as spam offers to block too, and the blocked address Not spam would take off the list.
 */
export async function spamChoices(db: Db, conversation: Marked, admin: boolean): Promise<{ blockDomain: string | null; unblocks: string | null }> {
  const sender = admin ? await conversationSender(db, conversation) : null;
  if (!sender) {
    return { blockDomain: null, unblocks: null };
  }
  const on = await listed(db, conversation.projectId, sender);
  return { blockDomain: on.domain?.blocked ? null : blockableDomain(sender), unblocks: on.address?.blocked ? sender : null };
}

/**
 * A teammate marked a conversation Spam or Not spam: where check 1 would apply to its sender, the sender's decision is
 * kept too, as the conversation's own mark (one per conversation, deleted with it; the newest on an address wins).
 * Returns what Not spam leaves behind, to say, so it never looks more lasting than it is:
 * - A blocked address: an owner's or admin's Not spam takes it off the list; a member's leaves it, and the list beats their mark.
 * - A blocked domain: an owner's or admin's is an exception for this sender; a member's isn't kept at all.
 * - `reason`, why the filter had filed it: the flood limit still applies, mail that fails DMARC is still filed, and so
 *   is a phrase's next match from a sender nothing is kept about.
 */
export async function recordMark(db: Db, conversation: Marked, spam: boolean, admin: boolean, reason: string | null): Promise<string | undefined> {
  const sender = await conversationSender(db, conversation);
  const notices: string[] = [];
  if (sender) {
    const on = spam ? null : await listed(db, conversation.projectId, sender);
    const mark = { sender, blocked: spam, byAdmin: admin, decidedAt: new Date() };
    let kept = true;
    if (on?.address?.blocked) {
      if (admin) {
        // Not `delete`: unblocked from another of their conversations at once, it's gone already, which is what was asked.
        await db.spamSender.deleteMany({ where: { id: on.address.id } });
      }
      notices.push(admin ? `${sender} is unblocked.` : `${sender} stays blocked: an owner or admin can unblock it.`);
    } else if (on?.domain?.blocked && !on.address) {
      kept = admin;
      notices.push(
        admin
          ? `${on.domain.sender} stays blocked. ${sender} is let through from now on.`
          : `${on.domain.sender} stays blocked: an owner or admin can let ${sender} through.`,
      );
    }
    if (kept) {
      await db.spamSender.upsert({ where: { conversationId: conversation.id }, create: { ...mark, projectId: conversation.projectId, conversationId: conversation.id }, update: mark });
    } else {
      // Unmarked, and nothing more: the mark it had goes with that.
      await db.spamSender.deleteMany({ where: { conversationId: conversation.id } });
    }
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
  await listSender(db, conversation.projectId, domain, true);
  return domain;
}

/**
 * An address or a domain on the team's blocked or allowed list, an owner's or admin's doing. One entry per address or
 * domain on the lists (the partial unique index): on this list now, whichever it was on.
 */
export async function listSender(db: Db, projectId: string, sender: string, blocked: boolean) {
  await db.$executeRaw`
    INSERT INTO spam_sender (id, "projectId", sender, blocked, "byAdmin", "decidedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${sender}, ${blocked}, true, ${new Date()})
    ON CONFLICT ("projectId", sender) WHERE "conversationId" IS NULL
    DO UPDATE SET blocked = EXCLUDED.blocked, "byAdmin" = true, "decidedAt" = EXCLUDED."decidedAt"`;
}
