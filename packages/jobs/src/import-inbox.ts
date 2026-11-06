import { randomUUID } from "node:crypto";

import { attachmentName, type Doc, fileExtension, isSafeLink, toPlainText, UPLOAD_FILE_TYPES } from "@tuti/content";
import { fileName, htmlText, htmlToContent, type LeftOutReason } from "@tuti/content/html";
import { type ConversationStatus, type MessageAuthor, type Prisma, prisma } from "@tuti/db";
import { historyKeptDays } from "@tuti/shared";
import { stripQuotes } from "@tuti/shared/email-quotes";
import { mediaStorage } from "@tuti/shared/storage";

import { MAX_TRIES } from "./conversations";
import { type FeaturebaseConversation, FeaturebaseError, inFeaturebaseStorage, type FeaturebasePart, type FeaturebasePartAuthor } from "./featurebase";
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
/** The part repeating the conversation's start comes about a second after it: one this much later isn't the start. */
const OPENING_MS = 60_000;
/** A message's text at most, as a received email's is cut (apps/web operations/conversations.ts MAX_MESSAGE_LENGTH). */
const MAX_MESSAGE_LENGTH = 10_000;
/** The whole email kept behind its message, at most (apps/web server/inbound.ts). */
const MAX_ORIGINAL_LENGTH = 200_000;
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
  /** An email's whole text, when its quote was cut from the body (as a received email's). */
  original: string | null;
  createdAt: Date;
  seenAt: Date | null;
  files: StoredFile[];
  /** Files it had that were left out (no media storage, too big, unreachable, no time): the message says how many. */
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
  /** Featurebase sent only its newest 500 parts: the messages before them are missing. */
  cutShort: boolean;
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
  // The first part repeats the conversation's source. Featurebase sends the newest 500: only when that cut off the start
  // (its oldest part well after the conversation began) is the source needed, and the conversation counted as cut.
  const source = conversation.source;
  const cutShort = parts.length >= MAX_PARTS && Date.parse(parts[0]!.createdAt) - Date.parse(conversation.createdAt) > OPENING_MS;
  if (cutShort && source?.bodyHtml) {
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
    const { body: text, urls, media, unshown } = await messageText(part);
    // An email shows its new part, as a received one does, the whole of it kept behind it (a widget message never quotes);
    // one that starts the conversation as a forward is kept whole, by its subject.
    const subject = messages.length === 0 ? (source?.subject ?? conversation.title ?? "") : "";
    const { text: body, stripped } = part.channel === "email" && !kind.note ? stripQuotes(text, subject) : { text, stripped: false };
    const files: StoredFile[] = [];
    let dropped = unshown;
    for (const url of urls) {
      const stored = Date.now() < copyUntil ? await copyAttachment(job, url) : { leftOut: null };
      if ("leftOut" in stored) {
        leftOut.push(stored.leftOut ? (LEFT_OUT[stored.leftOut] ?? "that couldn't be fetched") : NO_TIME);
        dropped++;
      } else {
        files.push(stored);
      }
    }
    // A message that was only an image or file stays, whatever became of it: who wrote last decides the status.
    if (!body && !media) {
      continue;
    }
    const author = part.author ?? null;
    messages.push({
      ...kind,
      contactId: kind.author === "USER" && CONTACT.has(author?.type ?? "") ? (author?.id ?? null) : null,
      admin: kind.author === "TEAM" && author?.type === "admin" && author.id ? author : null,
      channel: part.channel === "email" ? "EMAIL" : "WIDGET",
      body: body.slice(0, MAX_MESSAGE_LENGTH),
      original: stripped ? text.slice(0, MAX_ORIGINAL_LENGTH) : null,
      createdAt: new Date(part.createdAt),
      seenAt: kind.author === "TEAM" && !kind.note && i <= readTo ? seenAt : null,
      files,
      dropped,
    });
  }
  const email = parts.find((p) => CONTACT.has(p.author?.type ?? "") && p.author?.email)?.author?.email?.trim().toLowerCase() ?? null;
  const snoozed = parts.findLast((p) => p.partType === "status" && p.status === "snoozed");
  return { conversation, contactId, email, messages, leftOut, snoozedAt: snoozed ? new Date(snoozed.createdAt) : null, cutShort };
}

/**
 * A part's HTML as the inbox's plain text (links' addresses kept after their words, list items marked), and the
 * addresses of its images and files in Featurebase's storage, which come across as attachments. Other sites' images
 * and videos aren't fetched (as inbound email doesn't); a message that is only those shows their addresses, one with
 * words of its own only their alt text (signature logos, icons and tracking pixels would be links otherwise). `media`:
 * whether it had any (with an address); `unshown`: those neither copied nor shown by their address, for it to count.
 */
async function messageText(part: FeaturebasePart): Promise<{ body: string; urls: string[]; media: boolean; unshown: number }> {
  // bodyHtml: bodyMarkdown drops images' addresses.
  const content = await htmlToContent("post", part.bodyHtml ?? "");
  if ("error" in content) {
    // Too long to be content, say: its text (bodyMarkdown, or the HTML's own) and its Featurebase files all the same.
    const html = await htmlText(part.bodyHtml ?? "");
    const urls = [...new Set(html.urls.filter(inFeaturebaseStorage))];
    return { body: part.bodyMarkdown?.trim() || html.text, urls, media: urls.length > 0, unshown: 0 };
  }
  // A video with no source has nothing to bring or show.
  const media = content.leftOut.filter((item) => item.url);
  const urls = [...new Set(media.map((item) => item.url).filter(inFeaturebaseStorage))];
  const outside = media.filter((item) => !inFeaturebaseStorage(item.url));
  const text = toPlainText(readable(content.doc));
  const links = text ? [] : [...new Set(outside.map((item) => item.url).filter(isSafeLink))];
  const body = text || links.join("\n");
  return { body, urls, media: media.length > 0, unshown: text ? 0 : outside.filter((item) => !isSafeLink(item.url)).length };
}

/** The doc with each link's address after its words (unless they're the address) and list items marked, for plain text. */
function readable(node: Node): Node {
  const content = node.content && withAddresses(node.content.map(readable));
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

/** A link's address after its words, once per run of text nodes it marks (bold words inside it split it in nodes). */
function withAddresses(nodes: Node[]): Node[] {
  const hrefOf = (node: Node) => (node.type === "text" ? (node.marks?.find((mark) => mark.type === "link")?.attrs?.href as string | undefined) : undefined);
  const out = [...nodes];
  for (let i = 0; i < out.length; ) {
    const href = hrefOf(out[i]!);
    let end = i + 1;
    while (href && end < out.length && hrefOf(out[end]!) === href) {
      end++;
    }
    const words = out.slice(i, end).map((node) => node.text).join("");
    if (href && href.replace(/^mailto:/, "") !== words) {
      out[end - 1] = { ...out[end - 1]!, text: `${out[end - 1]!.text} (${href})` };
    }
    i = end;
  }
  return out;
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
  // One write for them all, ids made here so files go to theirs: a page's save under the lock stays short.
  const rows = messages.map((m) => ({ m, id: randomUUID() }));
  await tx.conversationMessage.createMany({
    data: rows.map(({ m, id: messageId }) => ({
      id: messageId,
      projectId: job.projectId,
      conversationId: id,
      author: m.author,
      authorId: m.author === "USER" ? (m.contactId && users.get(m.contactId)) || userId : m.admin ? admins.get(m.admin.id!)! : null,
      channel: m.channel,
      body: m.body,
      original: m.original,
      note: m.note,
      createdAt: m.createdAt,
      seenAt: m.seenAt,
      attachmentsDropped: m.dropped,
      importId: job.id,
      // The reply emails' tries used up: a worker from before importId skips it too, while a deploy overlaps.
      emailAttempts: m.author === "TEAM" ? MAX_TRIES : 0,
    })),
  });
  const files = rows.flatMap(({ m, id: messageId }) => m.files.map((file) => ({ file: file.id, messageId })));
  if (files.length > 0) {
    await tx.$executeRaw`
      UPDATE conversation_attachment a SET "messageId" = f.message
      FROM unnest(${files.map((f) => f.file)}::text[], ${files.map((f) => f.messageId)}::text[]) AS f(id, message)
      WHERE a.id = f.id AND a."messageId" IS NULL`;
    tally(job.counts, "attachments", null, files.length);
  }
  read.leftOut.forEach((reason) => tally(job.counts, "attachments", reason));
  if (read.cutShort) {
    tally(job.counts, "conversations", "whose messages before their newest 500 are missing: Featurebase gives no more");
  }
  await tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind: "conversation", externalId: c.id, localId: id } });
}

/** A subject from a message: its first line, cut (apps/web lib/format.ts subjectFrom). */
const subjectFrom = (text: string) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * Cuts the quotes from emails imported before imports cut them, the whole email kept behind each, as an import does now
 * (a conversation's first message by its subject, a forward kept whole). Run once by apps/worker's `cut:imported-quotes`,
 * a page at a time; nothing is lost, so running it again changes nothing.
 */
export async function cutImportedQuotes(): Promise<number> {
  let cut = 0;
  let after: string | undefined;
  for (;;) {
    const messages = await prisma.conversationMessage.findMany({
      where: { importId: { not: null }, channel: "EMAIL", note: false, original: null, ...(after && { id: { gt: after } }) },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true, body: true, conversation: { select: { subject: true, messages: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true } } } } },
    });
    for (const { id, body, conversation } of messages) {
      const { text, stripped } = stripQuotes(body, conversation.messages[0]?.id === id ? conversation.subject : "");
      if (stripped) {
        await prisma.conversationMessage.update({ where: { id }, data: { body: text, original: body } });
        cut++;
      }
    }
    if (messages.length < 200) {
      return cut;
    }
    after = messages.at(-1)!.id;
  }
}
