import { createHash } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { REPLY_PREFIXES, stripQuotes } from "@tuti/shared/email-quotes";
import { convert as htmlToText } from "html-to-text";
import { simpleParser } from "mailparser";

import { noiseReason } from "@/lib/email-noise";

import {
  addMessage,
  announceConversation,
  announceUserMessage,
  conversationPerson,
  MAX_MESSAGE_LENGTH,
  startConversation,
} from "./operations/conversations";
import { storeAttachments } from "./attachments";

/**
 * Receiving email in the support inbox (docs/plan.md, Support inbox, "Receiving email"): each project
 * has an address on the support domain, `support@<subdomain>.<SUPPORT_EMAIL_DOMAIN>`, its team
 * forwards its own support address to; whatever receives mail for the domain posts each message to
 * /api/inbound/email, and it's read here: stored first, then added to a conversation (or ignored, with
 * the reason), in one transaction, so a redelivery or a retry adds it once.
 */

export const MAX_RECEIVED_BYTES = 25 * 1024 * 1024;
/** More than this an hour, and a project's mail is refused (kept as a row, without its body). */
export const RECEIVED_PER_HOUR = 500;
/** Raw bodies not yet read or failed, per project and per server: past either, mail is refused. */
const PENDING_BYTES_PER_PROJECT = 1024 ** 3;
const PENDING_BYTES_PER_SERVER = 20 * 1024 ** 3;

/** The domain support addresses are on, or null when the server doesn't receive email. */
export function supportDomain(): string | null {
  return process.env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase() || null;
}

/** A project's support address, and a conversation's reply address on it. */
export const supportAddress = (subdomain: string, domain: string, token?: string) =>
  `support${token ? `+${token}` : ""}@${subdomain}.${domain}`;

/** The project and reply token an address on the support domain is for. */
function recipientOf(address: string, domain: string) {
  const at = address.lastIndexOf("@");
  const host = address.slice(at + 1).toLowerCase();
  if (at < 1 || !host.endsWith(`.${domain}`)) {
    return null;
  }
  const subdomain = host.slice(0, -domain.length - 1);
  const token = /\+([a-f0-9]{32})$/i.exec(address.slice(0, at))?.[1]?.toLowerCase() ?? null;
  return subdomain.includes(".") ? null : { subdomain, token };
}

export { mailSubdomain } from "@tuti/jobs";

/**
 * An email's HTML as text: links kept, images left out, quotes as "> ". Only so much of it and so
 * deep (the reply is at the top), and quotes marked up to five deep, so the text grows with the
 * HTML rather than with how deep its quotes go.
 */
function htmlAsText(html: string): string {
  let depth = 0;
  return htmlToText(html.slice(0, 500_000), {
    wordwrap: false,
    limits: { maxDepth: 200 },
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "blockquote", format: "quote" },
    ],
    formatters: {
      quote: (elem, walk, builder) => {
        const marked = ++depth <= 5;
        builder.openBlock({ leadingLineBreaks: 2, reservedLineLength: marked ? 2 : 0 });
        walk(elem.children, builder);
        builder.closeBlock({
          trailingLineBreaks: 2,
          blockTransform: marked ? (text) => trimLineBreaks(text).split("\n").map((line) => `> ${line}`).join("\n") : undefined,
        });
        depth--;
      },
    },
  });
}

function trimLineBreaks(text: string) {
  let start = 0;
  let end = text.length;
  while (text[start] === "\n") start++;
  while (end > start && text[end - 1] === "\n") end--;
  return text.slice(start, end);
}

export type Authentication = { spf: string; dkim: string; dmarc: string };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Headers by lowercase name, as their text. */
function headersOf(lines: readonly { key: string; line: string }[]) {
  const headers = new Map<string, string>();
  for (const { key, line } of lines) {
    if (!headers.has(key.toLowerCase())) {
      headers.set(key.toLowerCase(), line.slice(line.indexOf(":") + 1).trim());
    }
  }
  return headers;
}

/** The addresses these headers name, lowercase. */
const addressesIn = (lines: readonly { key: string; line: string }[], keys: string[]) =>
  lines
    .filter(({ key }) => keys.includes(key.toLowerCase()))
    .flatMap(({ line }) => line.slice(line.indexOf(":") + 1).toLowerCase().match(/[^\s<>,;:"()]+@[a-z0-9.-]+/g) ?? []);

/**
 * The addresses a forwarded email was first sent to: its To and Cc (forwarders keep them), and what
 * forwarders add (Gmail's X-Forwarded-For). None when To or Cc names an address on the support domain:
 * then it was sent here directly, perhaps with the team's address beside it, which proves no forwarding.
 */
function forwardedFrom(lines: readonly { key: string; line: string }[], domain: string) {
  const addressed = addressesIn(lines, ["to", "cc"]);
  if (addressed.some((address) => address.endsWith(`@${domain}`) || address.endsWith(`.${domain}`))) {
    return [];
  }
  return [...addressed, ...addressesIn(lines, ["delivered-to", "x-original-to", "x-forwarded-for", "x-gm-original-to"])];
}

/** What happened to it, as the receiver should hear it: 200 (taken, ignored or refused), 404 (no such address), 500 (try again). */
export type Received = { status: 200 | 404 | 500; outcome: string };

/** Receives one raw message sent to `recipient` (the envelope's), as the receiver authenticated it. */
export async function receiveEmail(recipient: string, auth: Authentication, raw: Buffer): Promise<Received> {
  const domain = supportDomain();
  const to = domain ? recipientOf(recipient.trim().toLowerCase(), domain) : null;
  const owner = to ? await prisma.mailSubdomain.findUnique({ where: { subdomain: to.subdomain }, select: { projectId: true } }) : null;
  if (!to || !owner?.projectId) {
    return { status: 404, outcome: "no such address" };
  }
  const projectId = owner.projectId;
  // The parser turns no HTML into text (htmlAsText does, in readEmail) but says where it would have,
  // in textConversionError, and makes no HTML of the text or inline images.
  let mail = await simpleParser(raw, { maxHtmlLengthToParse: 0, skipTextToHtml: true, skipImageLinks: true });
  // An HTML part beside the text rather than instead of it: only the parser knows which part that
  // is, so it reads the email again and turns that part into text, where that's quick (short HTML,
  // few quotes). Past that, readEmail puts all its HTML, as text, after the text.
  if (mail.textConversionError && mail.text?.trim() && typeof mail.html === "string" && mail.html.length <= 200_000 && (mail.html.match(/<blockquote/gi) ?? []).length <= 5) {
    mail = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true });
  }
  const sender = mail.from?.value[0]?.address?.toLowerCase() ?? "";
  const messageId = mail.messageId ?? null;
  const dedupeKey = sha256(messageId ? `${messageId}\n${sender}` : raw);
  const subject = (mail.subject ?? "").slice(0, 500);

  // Stored first (or found, if this is a redelivery), unless a limit says no.
  const store = () => prisma.$transaction(async (tx) => {
    const seen = await tx.inboundEmail.findUnique({ where: { projectId_dedupeKey: { projectId, dedupeKey } } });
    if (seen) {
      return seen;
    }
    // One at a time per project, then per server (always in that order), so the limits hold.
    await lockProject(tx, projectId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, 0)`;
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const [lastHour, projectPending, serverPending] = await Promise.all([
      tx.inboundEmail.count({ where: { projectId, createdAt: { gt: hourAgo } } }),
      tx.inboundEmail.aggregate({ where: { projectId, raw: { not: null } }, _sum: { size: true } }),
      tx.inboundEmail.aggregate({ where: { raw: { not: null } }, _sum: { size: true } }),
    ]);
    const refused =
      lastHour >= RECEIVED_PER_HOUR
        ? "over_hourly_limit"
        : (projectPending._sum.size ?? 0) + raw.length > PENDING_BYTES_PER_PROJECT
          ? "over_project_storage"
          : (serverPending._sum.size ?? 0) + raw.length > PENDING_BYTES_PER_SERVER
            ? "over_server_storage"
            : null;
    return tx.inboundEmail.create({
      data: {
        projectId,
        recipient: recipient.trim().toLowerCase(),
        sender,
        subject,
        messageId,
        dedupeKey,
        raw: refused ? null : new Uint8Array(raw),
        size: raw.length,
        ...auth,
        status: refused ? "REFUSED" : "RECEIVED",
        reason: refused ?? "",
      },
    });
  });
  // The same message delivered twice at once: the second finds the first's row.
  const row = await store().catch(async (error: unknown) => {
    const seen = await prisma.inboundEmail.findUnique({ where: { projectId_dedupeKey: { projectId, dedupeKey } } });
    if (!seen) {
      throw error;
    }
    return seen;
  });
  if (row.status !== "RECEIVED" && row.status !== "FAILED") {
    return { status: 200, outcome: row.status.toLowerCase() };
  }
  let outcome: string;
  try {
    outcome = await readEmail(row.id, projectId, to.token, auth, mail, sender);
  } catch (error) {
    if (error instanceof AlreadyRead) {
      return { status: 200, outcome: "already read" };
    }
    log.error("Reading a received email failed", { projectId, inboundEmailId: row.id, error });
    await prisma.inboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", reason: "processing_failed" } });
    return { status: 500, outcome: "failed" };
  }
  // Sent to the team's own address, forwarded here and in the Inbox: its forwarding works (Settings →
  // Support); list mail (a group's) and refused mail never get here. Only a status: anyone who knows
  // the support address can write headers that look forwarded. The email is in either way, so a
  // failure here mustn't fail it (a retry would add it again).
  const forwarded = outcome === "added" ? forwardedFrom(mail.headerLines, domain!) : [];
  if (forwarded.length > 0) {
    await prisma.emailDomain
      .updateMany({ where: { projectId, address: { in: forwarded } }, data: { receivedAt: new Date() } })
      .catch((error: unknown) => log.warn("Recording a forwarded email failed", { projectId, inboundEmailId: row.id, error }));
  }
  return { status: 200, outcome };
}

type Mail = Awaited<ReturnType<typeof simpleParser>>;

/**
 * Who's in a conversation by email: its person, and anyone who's written in it from another address. Not a signed-out
 * visitor's address: they typed it, never proved it, and read the conversation in the widget by their visitor token, so
 * mail from it (its owner answering the team's reply) starts a conversation of its own instead.
 */
async function conversationAddresses(conversationId: string) {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: {
      email: true,
      name: true,
      emailVerified: true,
      visitorHash: true,
      user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
      messages: { where: { fromAddress: { not: null } }, select: { fromAddress: true }, distinct: ["fromAddress"] },
    },
  });
  const unproven = !conversation.user && !!conversation.visitorHash && !conversation.emailVerified;
  const person = unproven ? undefined : conversationPerson(conversation).email?.toLowerCase();
  return { person, others: conversation.messages.map((m) => m.fromAddress!.toLowerCase()), unproven };
}

/**
 * The project's user with this address, when the mail proved its domain (DMARC passed): an account
 * that verified the address first, then someone from the project's app. Otherwise nobody, and the
 * conversation is with the address alone.
 */
async function userWithAddress(projectId: string, address: string): Promise<string | null> {
  const account = await prisma.user.findFirst({ where: { email: address, emailVerified: true, ssoIdentity: null }, select: { id: true } });
  if (account) {
    return account.id;
  }
  const sso = await prisma.ssoIdentity.findFirst({ where: { projectId, email: address }, orderBy: { updatedAt: "desc" }, select: { userId: true } });
  return sso?.userId ?? null;
}

/**
 * The name in an email's From ("Kim Lee <kim@…>"), trimmed and cut short. None when it has an address in it: the
 * sender's own again, or another one it would pass for in the Inbox's list and the team's emails. Look-alikes (a
 * fullwidth ＠) are folded first (NFKC), and control and formatting characters (a right-to-left override) dropped, but
 * not the zero-width joiners Persian, Indic and emoji names spell with.
 */
function fromName(mail: Mail) {
  const cleaned = mail.from?.value[0]?.name
    ?.normalize("NFKC")
    .replace(/(?![\u200C\u200D])[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  const name = cleaned && cutName(cleaned);
  // Something to show: a letter, number, symbol or punctuation once what draws nothing is set aside (joiners, Hangul
  // fillers, variation selectors, a blank braille cell). And no address in it.
  const shown = name?.replace(/[\s\p{Default_Ignorable_Code_Point}\u2800]/gu, "");
  return name && shown && /[\p{L}\p{N}\p{S}\p{P}]/u.test(shown) && !name.includes("@") ? name : null;
}

/**
 * Up to 100 of what a reader sees as one character (graphemes), so a flag or an emoji at the cut isn't left in half,
 * and never more than 200 UTF-16 units (one grapheme can carry any number of combining marks).
 */
function cutName(name: string) {
  let cut = "";
  let count = 0;
  for (const { segment } of new Intl.Segmenter().segment(name)) {
    if (count === 100 || cut.length + segment.length > 200) {
      break;
    }
    cut += segment;
    count++;
  }
  return cut.trim();
}

/** Another request read this email first. */
class AlreadyRead extends Error {}

/** Reads a stored email into the inbox; returns what happened ("added", or why it was ignored). */
async function readEmail(id: string, projectId: string, token: string | null, auth: Authentication, mail: Mail, sender: string): Promise<string> {
  const headers = headersOf(mail.headerLines);
  // Only from received or failed, in the transaction that adds its message: a second reader at the
  // same time (two redeliveries of a failed one) finds it read, and its own message rolls back.
  const finish = async (tx: Prisma.TransactionClient, data: Prisma.InboundEmailUpdateManyMutationInput & { conversationId?: string }) => {
    const { count } = await tx.inboundEmail.updateMany({ where: { id, status: { in: ["RECEIVED", "FAILED"] } }, data: { ...data, raw: null } });
    if (count !== 1) {
      throw new AlreadyRead();
    }
  };
  const ignore = async (reason: string) => {
    await prisma.$transaction((tx) => finish(tx, { status: "IGNORED", reason }));
    return reason;
  };

  const subject = mail.subject ?? "";
  const noise = noiseReason({ headers, from: sender, subject, nullSender: headers.get("return-path") === "<>" });
  if (noise) {
    return ignore(noise);
  }
  const domain = supportDomain()!;
  const senderHost = sender.slice(sender.lastIndexOf("@") + 1);
  if (senderHost === domain || senderHost.endsWith(`.${domain}`)) {
    return ignore("from_own_address");
  }

  // Its plain text and, where the parser left words in HTML (all of them, or a long part beside the
  // text), its HTML as text after it.
  const html = (mail.textConversionError || !mail.text) && typeof mail.html === "string" ? htmlAsText(mail.html).trim() : "";
  const plain = html ? [mail.text?.trim(), html].filter(Boolean).join("\n\n") : (mail.text ?? "");
  const { text, stripped } = stripQuotes(plain, subject);
  const body = (text || "(No text)").slice(0, MAX_MESSAGE_LENGTH);
  // What came with it (not the images its HTML shows inline: logos, signatures), kept before its
  // message is written, and removed again if it isn't.
  const files = (mail.attachments ?? []).filter((a) => !a.related).map((a) => ({ filename: a.filename ?? "", contentType: a.contentType, content: a.content }));
  const attachments = await storeAttachments(projectId, files);
  const keepAttachments = async (tx: Prisma.TransactionClient, messageId: string) => {
    if (attachments.stored.length > 0) {
      await tx.conversationAttachment.createMany({ data: attachments.stored.map((file) => ({ ...file, projectId, messageId })) });
    }
  };
  const received = {
    emailMessageId: mail.messageId ?? null,
    original: stripped ? plain.slice(0, 200_000) : null,
    attachmentsDropped: attachments.dropped,
  };
  // Removed again only if nothing that points at them was written: once the message is in, they're its.
  let written = false;
  try {
    return await place();
  } catch (error) {
    if (!written) {
      await attachments.discard();
    }
    throw error;
  }

  async function place(): Promise<string> {
    const dmarcPassed = auth.dmarc === "pass";

    // A reply: the token in its address, else a Message-ID we sent that it names (In-Reply-To,
    // References), finds the conversation; but only its people, with DMARC passed, join it (the token
    // and our Message-IDs are random secrets sent only to them; DMARC proves the domain, not the mailbox).
    // The Message-IDs of mail we received never count: their senders chose them, and others have copies.
    const select = { id: true, number: true, userId: true, replyToken: true } as const;
    const named = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])].filter(
      (id): id is string => !!id,
    );
    const found =
      (token ? await prisma.conversation.findFirst({ where: { projectId, replyToken: token }, select }) : null) ??
      (named.length > 0
        ? ((
            await prisma.conversationMessage.findFirst({
              where: {
                projectId,
                OR: [{ sentMessageId: { in: named.slice(-50) } }, { deliveredMessageId: { in: named.slice(-50) } }],
              },
              orderBy: { createdAt: "desc" },
              select: { conversation: { select } },
            })
          )?.conversation ?? null)
        : null);
    if (found && dmarcPassed) {
      let conversation = found;
      let addresses = await conversationAddresses(found.id);
      // A signed-out visitor's conversation: mail from its address started one of its own (below), and further
      // replies to the visitor's go on there, the latest one this address's proven mail (DMARC passed, so never one
      // forged into Spam) to its reply address went to, which they join by that conversation's own people. Replies
      // that lost the reply address (only its Message-IDs) start one each.
      if (addresses.unproven) {
        const earlier = await prisma.inboundEmail.findFirst({
          where: {
            projectId,
            sender,
            dmarc: "pass",
            status: "ADDED",
            recipient: { startsWith: `support+${found.replyToken}@` },
            conversationId: { not: found.id },
          },
          orderBy: { createdAt: "desc" },
          select: { conversationId: true },
        });
        const own = earlier && (await prisma.conversation.findFirst({ where: { id: earlier.conversationId!, projectId }, select }));
        if (own) {
          conversation = own;
          addresses = await conversationAddresses(own.id);
        }
      }
      const { person, others } = addresses;
      if (sender === person || others.includes(sender)) {
        const message = await addMessage(
          conversation.id,
          projectId,
          {
            author: "USER",
            authorId: sender === person ? conversation.userId : null,
            channel: "EMAIL",
            body,
            ...received,
            fromAddress: sender === person ? null : sender,
          },
          async (tx, messageId) => {
            await keepAttachments(tx, messageId);
            await finish(tx, { status: "ADDED", conversationId: conversation.id });
          },
        );
        written = true;
        await announceUserMessage(projectId, conversation.number, message);
        return "added";
      }
    }

    // Anything else starts a conversation: with the project's user who has this address when DMARC
    // passed, else with the address alone; mail that failed DMARC goes to Spam.
    const userId = dmarcPassed ? await userWithAddress(projectId, sender) : null;
    const started = await startConversation(projectId, {
      userId,
      email: userId ? null : sender,
      name: userId ? null : fromName(mail),
      subject: subject.replace(REPLY_PREFIXES, "").trim().slice(0, 200) || undefined,
      body,
      origin: "EMAIL",
      channel: "EMAIL",
      spam: auth.dmarc === "fail",
      received: { ...received, fromAddress: null },
      alongside: async (tx, conversationId, messageId) => {
        if (!userId) {
          await tx.conversation.update({ where: { id: conversationId }, data: { emailVerified: dmarcPassed } });
        }
        await keepAttachments(tx, messageId);
        await finish(tx, { status: "ADDED", conversationId });
      },
    });
    written = true;
    if (auth.dmarc !== "fail") {
      await announceConversation(projectId, started.conversation, started.message);
    }
    return "added";
  }
}
