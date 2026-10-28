import { createHash } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { simpleParser } from "mailparser";

import { REPLY_PREFIXES, stripQuotes } from "@/lib/email-quotes";
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

/**
 * The project's mail subdomain, chosen from its slug the first time (with a number added if that's
 * taken: `acme-2`), and its for good: it doesn't follow slug changes, and nobody else ever gets it.
 */
export async function mailSubdomain(projectId: string): Promise<string> {
  const existing = await prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } });
  if (existing) {
    return existing.subdomain;
  }
  const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
  for (let n = 1; ; n++) {
    const subdomain = n === 1 ? slug : `${slug}-${n}`;
    const taken = await prisma.mailSubdomain.findUnique({ where: { subdomain }, select: { projectId: true } });
    if (taken) {
      if (taken.projectId === projectId) {
        return subdomain;
      }
      continue;
    }
    try {
      await prisma.mailSubdomain.create({ data: { subdomain, projectId } });
      return subdomain;
    } catch {
      // Taken meanwhile (by another project, or this one in another request): look again.
      const mine = await prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } });
      if (mine) {
        return mine.subdomain;
      }
    }
  }
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
  const mail = await simpleParser(raw);
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
  try {
    const outcome = await readEmail(row.id, projectId, to.token, auth, mail, sender);
    return { status: 200, outcome };
  } catch (error) {
    if (error instanceof AlreadyRead) {
      return { status: 200, outcome: "already read" };
    }
    log.error("Reading a received email failed", { projectId, inboundEmailId: row.id, error });
    await prisma.inboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", reason: "processing_failed" } });
    return { status: 500, outcome: "failed" };
  }
}

type Mail = Awaited<ReturnType<typeof simpleParser>>;

/** Who's in a conversation by email: its person, and anyone who's written in it from another address. */
async function conversationAddresses(conversationId: string) {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: {
      email: true,
      emailVerified: true,
      user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
      messages: { where: { fromAddress: { not: null } }, select: { fromAddress: true }, distinct: ["fromAddress"] },
    },
  });
  const person = conversationPerson(conversation).email?.toLowerCase();
  return { person, others: conversation.messages.map((m) => m.fromAddress!.toLowerCase()) };
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

  const { text, stripped } = stripQuotes(mail.text ?? "", subject);
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
    original: stripped ? (mail.text ?? "").slice(0, 200_000) : null,
    attachmentsDropped: attachments.dropped,
  };
  try {
    return await place();
  } catch (error) {
    await attachments.discard();
    throw error;
  }

  async function place(): Promise<string> {
    const dmarcPassed = auth.dmarc === "pass";

    // A reply: the token in its address, else a Message-ID we sent that it names (In-Reply-To,
    // References), finds the conversation; but only its people, with DMARC passed, join it (the token
    // and our Message-IDs are random secrets sent only to them; DMARC proves the domain, not the mailbox).
    // The Message-IDs of mail we received never count: their senders chose them, and others have copies.
    const select = { id: true, number: true, userId: true } as const;
    const named = [mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])].filter(
      (id): id is string => !!id,
    );
    const conversation =
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
    if (conversation && dmarcPassed) {
      const { person, others } = await conversationAddresses(conversation.id);
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
    if (auth.dmarc !== "fail") {
      await announceConversation(projectId, started.conversation, started.message);
    }
    return "added";
  }
}
