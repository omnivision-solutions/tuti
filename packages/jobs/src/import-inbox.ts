import { randomUUID } from "node:crypto";

import { attachmentName, type Doc, fileExtension, toPlainText, UPLOAD_FILE_TYPES } from "@tuti/content";
import { fileName, htmlToContent, type LeftOutReason } from "@tuti/content/html";
import { type ConversationStatus, type MessageAuthor, type Prisma, prisma } from "@tuti/db";
import { historyKeptDays } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

import { MAX_TRIES } from "./conversations";
import { type FeaturebaseConversation, FeaturebaseError, type FeaturebasePart, type FeaturebasePartAuthor } from "./featurebase";
import { download } from "./import-media";
import { ALREADY_HERE, adminMember, contactUsers, type ImportJob, loadAdmins, type StepPage, tally } from "./imports";

/**
 * The inbox from Featurebase (docs/plan.md, Switching from Featurebase, I5): every conversation still going, and the
 * closed ones Tuti keeps, with their messages and notes; images in them as attachments. Each conversation is read with
 * its parts (the newest 500) and its files copied before the page's transaction; nothing is emailed.
 */

type Tx = Prisma.TransactionClient;

/** Conversations a list page has: each is read on its own and its files copied. */
const PAGE = 10;
/**
 * Featurebase's reads end within the page's budget (imports.ts PAGE_READ_MS, 3 minutes) however long files take to
 * copy: from the page's start, a page stops reading conversations after READ_FOR_MS, saves those it read and reads the
 * same list page again (its cursor marked AGAIN); it always reads one, so it gets on, and past COPY_FOR_MS (a download
 * takes 30 seconds at most) that one's remaining files are left out, so the contacts it needs are still read in time.
 */
const READ_FOR_MS = 90_000;
const COPY_FOR_MS = 120_000;
/** Why a file was left out when the page ran out of time. */
const NO_TIME = "that the page had no time left to copy";
const AGAIN = "again:";
const DAY_MS = 86_400_000;
/** Featurebase sends at most this many parts of a conversation, the newest: one with that many has lost its start. */
const MAX_PARTS = 500;
/** As the inbox's own attachments (apps/web server/attachments.ts MAX_FILE_BYTES). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** Why an attachment was left out, as the import's summary says it. */
const LEFT_OUT: Partial<Record<LeftOutReason, string>> = {
  unsupported: "as this server has no media storage",
  size: `over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
};
const CONTACT = new Set(["customer", "lead"]);

type Node = NonNullable<Doc["content"]>[number];
/** A copied file's attachment row, not on a message yet (the daily cleanup removes it if its page is never saved). */
type StoredFile = { id: string };
type Message = {
  author: MessageAuthor;
  note: boolean;
  /** Who wrote it there: a contact's id (USER), an admin (TEAM). */
  contactId: string | null;
  admin: FeaturebasePartAuthor | null;
  channel: "EMAIL" | "WIDGET";
  body: string;
  createdAt: Date;
  seenAt: Date | null;
  files: StoredFile[];
  /** Files left out because the server has no media storage: the message says so, as a received email's does. */
  dropped: number;
};
type Read = {
  conversation: FeaturebaseConversation;
  contactId: string | null;
  email: string | null;
  messages: Message[];
  leftOut: string[];
  /** When it was last snoozed there (its latest status change to snoozed), if it was. */
  snoozedAt: Date | null;
};

/** When it was last active there: what Tuti's history goes by (activeAt). */
const lastActive = (c: FeaturebaseConversation) => new Date(c.lastActivityAt ?? c.updatedAt ?? c.createdAt);

/**
 * Conversations, a page at a time. Each is numbered as it's saved, in the order Featurebase lists them (the newest
 * first), so a number never changes once given, whatever fails and is started again; an older one a later import
 * brings gets the next number.
 */
export async function conversationsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const started = Date.now();
  const again = cursor?.startsWith(AGAIN) ?? false;
  const listCursor = again ? cursor!.slice(AGAIN.length) || null : cursor;
  const { items, next } = await job.featurebase.page<FeaturebaseConversation>("/conversations", listCursor, { limit: PAGE });
  await loadAdmins(job);
  let cut = false;
  // Closed ones older than Tuti keeps would be deleted by the daily history job: counted, not imported.
  const days = historyKeptDays();
  const tooOld = (c: FeaturebaseConversation) => c.state === "closed" && days !== null && lastActive(c).getTime() < Date.now() - days * DAY_MS;
  const kept = items.filter((c) => !tooOld(c));
  const known = await recorded(prisma, job, kept.map((c) => c.id));
  const read: Read[] = [];
  for (const listed of kept.filter((c) => !known.has(c.id))) {
    if (read.length > 0 && Date.now() - started > READ_FOR_MS) {
      cut = true;
      break;
    }
    // Read and its files copied at once: their signed addresses expire within the hour. One deleted since is skipped.
    const conversation = await job.featurebase.get<FeaturebaseConversation>(`/conversations/${encodeURIComponent(listed.id)}`).catch((error: unknown) => {
      if (error instanceof FeaturebaseError && error.status === 404) {
        return null;
      }
      throw error;
    });
    if (conversation) {
      read.push(await readConversation(job, conversation, started + COPY_FOR_MS));
    }
  }
  const contacts = await contactUsers(job, read.flatMap((r) => [r.contactId, ...r.messages.map((m) => m.contactId)].filter((id) => id !== null)));
  return {
    next: cut ? AGAIN + (listCursor ?? "") : next,
    save: async (tx) => {
      const users = await contacts.save(tx);
      // Saved by a run of this page that got there first: once.
      const saved = await recorded(tx, job, read.map((r) => r.conversation.id));
      const fresh = read.filter((r) => !saved.has(r.conversation.id));
      for (const r of fresh) {
        await saveConversation(tx, job, r, users);
      }
      tally(job.counts, "conversations", null, fresh.length);
      // Read again, the list page was counted the first time: only what it reads now counts.
      const already = (again ? 0 : known.size) + read.length - fresh.length;
      if (already > 0) {
        tally(job.counts, "conversations", ALREADY_HERE, already);
      }
      const old = items.length - kept.length;
      if (old > 0 && !again) {
        tally(job.counts, "conversations", `closed more than ${days} days ago, past what Tuti keeps`, old);
      }
    },
  };
}

/** The conversations of these Featurebase ids the project's imports brought: local ids, by Featurebase's. */
async function recorded(tx: Tx | typeof prisma, job: ImportJob, ids: string[]): Promise<Map<string, string>> {
  const rows = await tx.importedRecord.findMany({ where: { projectId: job.projectId, source: job.source, kind: "conversation", externalId: { in: ids } }, select: { externalId: true, localId: true } });
  return new Map(rows.map((row) => [row.externalId, row.localId]));
}

/** What a part is here (null: an event, a quick reply, a rating, an attribute prompt: not a message). */
function kindOf(part: FeaturebasePart): { author: MessageAuthor; note: boolean } | null {
  switch (part.partType) {
    case "user_msg":
    case "email_msg":
      // A teammate's reply by email comes as an email_msg too.
      return { author: part.author?.type === "admin" ? "TEAM" : "USER", note: false };
    case "admin_msg":
      return { author: "TEAM", note: false };
    case "admin_note":
      return { author: "TEAM", note: true };
    case "bot_msg":
      return { author: "AI", note: false };
    default:
      return null;
  }
}

/** A conversation's messages, its person and its files (copied now), before the page's transaction. */
async function readConversation(job: ImportJob, conversation: FeaturebaseConversation, copyUntil: number): Promise<Read> {
  const parts = [...(conversation.conversationParts ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // The first part repeats the conversation's source; only once the start is cut off (the newest 500) is the source needed.
  const source = conversation.source;
  if (parts.length >= MAX_PARTS && source?.bodyHtml) {
    parts.unshift({ id: "source", partType: "user_msg", createdAt: conversation.createdAt, bodyHtml: source.bodyHtml, channel: source.channel, author: source.author });
  }
  // Their person: the contact taking part, else who started it or wrote.
  const contactId =
    conversation.participants?.find((p) => CONTACT.has(p.type))?.id ?? (CONTACT.has(source?.author?.type ?? "") ? source!.author!.id : null) ?? parts.find((p) => CONTACT.has(p.author?.type ?? ""))?.author?.id ?? null;
  // How far they read (Featurebase's read receipt): the team's messages up to there are seen.
  const receipt = conversation.readReceipts?.find((r) => r.userType !== "admin" && (!contactId || r.id === contactId));
  const readTo = receipt ? parts.findIndex((p) => p.id === receipt.lastReadPartId) : -1;
  const seenAt = readTo >= 0 ? new Date(parts[readTo]!.createdAt) : null;

  const messages: Message[] = [];
  const leftOut: string[] = [];
  for (const [i, part] of parts.entries()) {
    const kind = kindOf(part);
    if (!kind) {
      continue;
    }
    const { body, urls } = await messageText(part);
    const files: StoredFile[] = [];
    let dropped = 0;
    for (const url of urls) {
      const stored = Date.now() < copyUntil ? await copyAttachment(job, url) : { leftOut: null };
      if ("leftOut" in stored) {
        leftOut.push(stored.leftOut ? (LEFT_OUT[stored.leftOut] ?? "that couldn't be fetched") : NO_TIME);
        dropped += stored.leftOut === "unsupported" ? 1 : 0;
      } else {
        files.push(stored);
      }
    }
    // A message that was only a file stays, its file left out or not: who wrote last decides the status.
    if (!body && urls.length === 0) {
      continue;
    }
    const author = part.author ?? null;
    messages.push({
      ...kind,
      contactId: kind.author === "USER" && CONTACT.has(author?.type ?? "") ? (author?.id ?? null) : null,
      admin: kind.author === "TEAM" && author?.type === "admin" && author.id ? author : null,
      channel: part.channel === "email" ? "EMAIL" : "WIDGET",
      body,
      createdAt: new Date(part.createdAt),
      seenAt: kind.author === "TEAM" && !kind.note && i <= readTo ? seenAt : null,
      files,
      dropped,
    });
  }
  const email = parts.find((p) => CONTACT.has(p.author?.type ?? "") && p.author?.email)?.author?.email?.trim().toLowerCase() ?? null;
  const snoozed = parts.findLast((p) => p.partType === "status" && p.status === "snoozed");
  return { conversation, contactId, email, messages, leftOut, snoozedAt: snoozed ? new Date(snoozed.createdAt) : null };
}

/**
 * A part's HTML as the inbox's plain text (links' addresses kept after their words, list items marked), and the
 * addresses of its images and Featurebase files, which come across as attachments.
 */
async function messageText(part: FeaturebasePart): Promise<{ body: string; urls: string[] }> {
  // bodyHtml: bodyMarkdown drops images' addresses.
  const content = await htmlToContent("post", part.bodyHtml ?? "");
  if ("error" in content) {
    return { body: part.bodyMarkdown?.trim() ?? "", urls: [] };
  }
  const urls = [...new Set(content.leftOut.map((item) => item.url).filter(Boolean))];
  return { body: toPlainText(readable(content.doc)), urls };
}

/** The doc with each link's address after its words (unless they're the address) and list items marked, for plain text. */
function readable(node: Node): Node {
  const content = node.content?.map(readable);
  if (node.type === "text") {
    const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href as string | undefined;
    return href && href.replace(/^mailto:/, "") !== node.text ? { ...node, text: `${node.text} (${href})` } : node;
  }
  if ((node.type === "bulletList" || node.type === "orderedList") && content) {
    const start = Number(node.attrs?.start ?? 1);
    const marked = content.map((item, i) => {
      const [first, ...rest] = item.content ?? [];
      const marker = { type: "text", text: node.type === "bulletList" ? "- " : `${start + i}. ` };
      return first?.type === "paragraph" ? { ...item, content: [{ ...first, content: [marker, ...(first.content ?? [])] }, ...rest] } : item;
    });
    return { ...node, content: marked };
  }
  return content ? { ...node, content } : node;
}

/** Copies a file into the inbox's attachment storage (as a received email's), outside any transaction; or why not. */
async function copyAttachment(job: ImportJob, url: string): Promise<StoredFile | { leftOut: LeftOutReason }> {
  const storage = mediaStorage();
  if (!storage) {
    return { leftOut: "unsupported" };
  }
  const body = await download(url, MAX_ATTACHMENT_BYTES);
  if (typeof body === "string") {
    return { leftOut: body };
  }
  const filename = attachmentName(fileName(url));
  const extension = fileExtension(filename);
  const contentType = IMAGE_TYPES[extension] ?? UPLOAD_FILE_TYPES[extension] ?? "application/octet-stream";
  const key = `attachments/${job.projectId}/${randomUUID()}`;
  await storage.put(key, body, contentType);
  // Its row at once, unattached: a page that's never saved (failed, or another run's got there first) leaves nothing
  // the daily cleanup doesn't find.
  return prisma.conversationAttachment.create({ data: { projectId: job.projectId, key, filename, contentType, size: body.byteLength }, select: { id: true } });
}

/** Saves a conversation read before, under the project's lock: its people looked up here, nothing emailed. */
async function saveConversation(tx: Tx, job: ImportJob, read: Read, users: Map<string, string>) {
  const { conversation: c, messages } = read;
  const userId = (read.contactId && users.get(read.contactId)) || null;
  // Held by a teammate there: assigned when they're on the team, else held by their placeholder (handed over when they join).
  const held = c.adminAssigneeId ? await adminMember(tx, job, c.adminAssigneeId) : null;
  const admins = new Map<string, string>();
  for (const { admin } of messages) {
    if (admin && !admins.has(admin.id!)) {
      admins.set(admin.id!, (await adminMember(tx, job, admin.id!, admin)).userId);
    }
  }

  // As the inbox moves a conversation on with each message: the team's reply answers the person, theirs waits for one.
  const spoken = messages.filter((m) => !m.note);
  let waitingSince: Date | null = null;
  for (const m of spoken) {
    waitingSince = m.author === "TEAM" ? null : m.author === "USER" ? (waitingSince ?? m.createdAt) : waitingSince;
  }
  const status: ConversationStatus = c.state === "closed" ? "CLOSED" : spoken.at(-1)?.author === "USER" ? "OPEN" : "WAITING";
  const snoozedUntil = c.state === "snoozed" && c.snoozedUntil ? new Date(c.snoozedUntil) : null;

  const { conversationCount: number } = await tx.project.update({ where: { id: job.projectId }, data: { conversationCount: { increment: 1 } }, select: { conversationCount: true } });
  // From what the user can see (the subject shows in the widget and their emails): never a note.
  const subject = c.title?.trim() || c.source?.subject?.trim() || subjectFrom(messages.find((m) => !m.note && m.body)?.body ?? "") || "Conversation";
  const { id } = await tx.conversation.create({
    data: {
      projectId: job.projectId,
      number,
      subject: subject.slice(0, 200),
      status,
      origin: c.source?.channel === "email" ? "EMAIL" : "WIDGET",
      userId,
      email: userId ? null : read.email,
      assigneeId: held?.member ? held.userId : null,
      heldById: held && !held.member ? held.userId : null,
      createdAt: new Date(c.createdAt),
      lastMessageAt: spoken.at(-1)?.createdAt ?? new Date(c.createdAt),
      activeAt: lastActive(c),
      waitingSince: status === "OPEN" ? waitingSince : null,
      snoozedUntil,
      snoozedAt: snoozedUntil && (read.snoozedAt ?? new Date()),
      // The team was told of it in Featurebase: nothing in its history is owed a notice (resubmitConversationNotices).
      notifiedAt: messages.at(-1)?.createdAt ?? new Date(c.createdAt),
    },
    select: { id: true },
  });
  for (const m of messages) {
    const message = await tx.conversationMessage.create({
      data: {
        projectId: job.projectId,
        conversationId: id,
        author: m.author,
        authorId: m.author === "USER" ? (m.contactId && users.get(m.contactId)) || userId : m.admin ? admins.get(m.admin.id!)! : null,
        channel: m.channel,
        body: m.body,
        note: m.note,
        createdAt: m.createdAt,
        seenAt: m.seenAt,
        attachmentsDropped: m.dropped,
        importId: job.id,
        // The reply emails' tries used up: a worker from before importId skips it too, while a deploy overlaps.
        ...(m.author === "TEAM" && { emailAttempts: MAX_TRIES }),
      },
      select: { id: true },
    });
    await tx.conversationAttachment.updateMany({ where: { id: { in: m.files.map((file) => file.id) }, messageId: null }, data: { messageId: message.id } });
    if (m.files.length > 0) {
      tally(job.counts, "attachments", null, m.files.length);
    }
  }
  read.leftOut.forEach((reason) => tally(job.counts, "attachments", reason));
  await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "conversation", externalId: c.id, localId: id } });
}

/** A subject from a message: its first line, cut (apps/web lib/format.ts subjectFrom). */
const subjectFrom = (text: string) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
