import { randomUUID } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

import { OperationError } from "./operations/define";

/**
 * Files that come with a support inbox message (docs/plan.md, Support inbox, item 9): kept whole in
 * the private media storage, one object per file under `attachments/<project>/`, and read with signed
 * links. Without media storage they're dropped, and the message says how many.
 */

const MB = 1024 * 1024;
/** Sent with a message (the team's reply, the widget): per file, per message, and how many (docs/plan.md, Support inbox, "Limits"). */
export const MAX_FILE_BYTES = 10 * MB;
export const MAX_MESSAGE_BYTES = 25 * MB;
export const MAX_FILES = 10;
/** Uploads one person may start in an hour. */
const UPLOADS_PER_HOUR = 50;

/** Shown in the page as images; anything else (SVG included: it can carry script) is a download. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type IncomingFile = { filename: string; contentType: string; content: Uint8Array };
export type StoredFile = { key: string; filename: string; contentType: string; size: number };

/** A type to store it as: what it says it is when that's a plain `type/subtype`, else just bytes. */
export function attachmentType(contentType: string) {
  return /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType.toLowerCase() : "application/octet-stream";
}

/** A name that's safe to show and to save as: no path, no control characters, not too long. */
export function attachmentName(name: string | undefined) {
  const base = (name ?? "").split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(-200) || "attachment";
}

/**
 * Stores the files before the message that carries them is written; `discard` removes them again if
 * it isn't. Without storage, nothing is kept and `dropped` says how many weren't.
 */
export async function storeAttachments(projectId: string, files: IncomingFile[]): Promise<{ stored: StoredFile[]; dropped: number; discard: () => Promise<void> }> {
  const storage = mediaStorage();
  if (!storage || files.length === 0) {
    return { stored: [], dropped: files.length, discard: async () => {} };
  }
  const stored: StoredFile[] = [];
  const discard = async () => {
    await Promise.all(stored.map((file) => storage.delete(file.key).catch((error: unknown) => log.warn("Deleting an unused attachment failed", { key: file.key, error }))));
  };
  try {
    for (const file of files) {
      const key = `attachments/${projectId}/${randomUUID()}`;
      const contentType = attachmentType(file.contentType);
      await storage.put(key, file.content, contentType);
      stored.push({ key, filename: attachmentName(file.filename), contentType, size: file.content.byteLength });
    }
  } catch (error) {
    await discard();
    throw error;
  }
  return { stored, dropped: 0, discard };
}

/** Links to read each attachment: images shown, everything else saved under its name. */
export async function attachmentLinks<T extends { id: string; key: string; filename: string; contentType: string }>(attachments: T[]) {
  const storage = mediaStorage();
  return Promise.all(
    attachments.map(async ({ key, ...attachment }) => {
      const image = IMAGE_TYPES.has(attachment.contentType);
      const url = storage ? await storage.signedUrl(key, undefined, image ? undefined : attachment.filename) : null;
      return { ...attachment, image, url };
    }),
  );
}

/**
 * A teammate's upload for a reply, before it's sent: its row (no message yet, theirs) and a URL the
 * browser PUTs exactly this file to. Never sent, it's removed after a day (cleanup-media).
 */
export async function startUpload(projectId: string, uploadedById: string, file: { filename: string; contentType: string; size: number }) {
  const storage = mediaStorage();
  if (!storage) {
    throw new OperationError(400, "invalid_input", "Attachments aren't set up on this server");
  }
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new OperationError(400, "invalid_input", `Attachments can be up to ${MAX_FILE_BYTES / MB} MB each`);
  }
  const recent = await prisma.conversationAttachment.count({
    where: { projectId, uploadedById, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
  });
  if (recent >= UPLOADS_PER_HOUR) {
    throw new OperationError(429, "rate_limited", "That's a lot of uploads: try again in a while");
  }
  const contentType = attachmentType(file.contentType);
  const row = await prisma.conversationAttachment.create({
    data: { projectId, uploadedById, key: `attachments/${projectId}/${randomUUID()}`, filename: attachmentName(file.filename), contentType, size: file.size },
    select: { id: true, key: true },
  });
  // The browser PUTs it with this type: the one signed.
  return { id: row.id, contentType, uploadUrl: await storage.presignPut(row.key, { contentType, size: file.size }) };
}

/**
 * The uploads a reply sends, checked: theirs, not sent yet, really in the storage, and within the
 * limits (sizes from the storage, not what the browser said).
 */
export async function checkUploads(projectId: string, uploadedById: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_FILES) {
    throw new OperationError(400, "invalid_input", `Send up to ${MAX_FILES} attachments at a time`);
  }
  const rows = await prisma.conversationAttachment.findMany({
    where: { id: { in: unique }, projectId, uploadedById, messageId: null },
    select: { id: true, key: true },
  });
  if (rows.length !== unique.length) {
    throw new OperationError(400, "invalid_input", "An attachment isn't there any more: add it again");
  }
  const storage = mediaStorage();
  const sizes = await Promise.all(rows.map((row) => storage?.head(row.key)));
  if (sizes.some((size) => !size)) {
    throw new OperationError(400, "invalid_input", "An attachment hasn't finished uploading");
  }
  if (sizes.some((size) => size!.size > MAX_FILE_BYTES)) {
    throw new OperationError(400, "invalid_input", `Attachments can be up to ${MAX_FILE_BYTES / MB} MB each`);
  }
  if (sizes.reduce((sum, size) => sum + size!.size, 0) > MAX_MESSAGE_BYTES) {
    throw new OperationError(400, "invalid_input", `A message's attachments can be up to ${MAX_MESSAGE_BYTES / MB} MB together`);
  }
  return rows.map((row, i) => ({ id: row.id, size: sizes[i]!.size }));
}

/** Gives checked uploads to their message, in its transaction: all of them, or none (another reply sent one first). */
export async function claimUploads(tx: Prisma.TransactionClient, uploads: { id: string; size: number }[], messageId: string) {
  for (const upload of uploads) {
    const { count } = await tx.conversationAttachment.updateMany({ where: { id: upload.id, messageId: null }, data: { messageId, size: upload.size } });
    if (count !== 1) {
      throw new OperationError(409, "conflict", "An attachment was just sent with another message: add it again");
    }
  }
}
