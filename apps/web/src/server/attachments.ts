import { randomUUID } from "node:crypto";

import { log } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

/**
 * Files that come with a support inbox message (docs/plan.md, Support inbox, item 9): kept whole in
 * the private media storage, one object per file under `attachments/<project>/`, and read with signed
 * links. Without media storage they're dropped, and the message says how many.
 */

/** Shown in the page as images; anything else (SVG included: it can carry script) is a download. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type IncomingFile = { filename: string; contentType: string; content: Uint8Array };
export type StoredFile = { key: string; filename: string; contentType: string; size: number };

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
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType.toLowerCase() : "application/octet-stream";
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
