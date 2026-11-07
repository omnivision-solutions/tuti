import type { ImportedMedia, LeftOutReason, MediaImporter, MediaSource } from "@tuti/content/html";
import { attachmentName, fileExtension, fileKey, isFileContent, originalKey, UPLOAD_FILE_TYPES, UPLOAD_VIDEO_TYPES, videoFormat, videoKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaLimit, mediaStorage } from "@tuti/shared/storage";
import { checkWebhookUrl, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import { imageUploaded } from "./images";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });
const MAX_REDIRECTS = 3;
/** Older than the last hour createUpload counts against an uploader. */
const OUTSIDE_UPLOAD_LIMIT_MS = 2 * 60 * 60 * 1000;
/** For one download, body and all: 30 seconds, or longer for a bigger limit (videos), at 1 MB a second. */
const timeoutFor = (maxBytes: number) => Math.max(30_000, Math.round(maxBytes / 1024));

type Copied = ImportedMedia | { leftOut: LeftOutReason };

/**
 * Copies images and files from another tool into a project's media (imports: `htmlToContent`'s `media`), as uploads
 * by `uploaderId`: fetched like webhooks (public addresses only, each redirect checked again, a time limit), up to the
 * limit for their kind (read while streaming; images have the import's own, larger than the app's, as they're
 * re-encoded before they're kept), checked by content (images re-encoded at once by the image job's own processing,
 * so they're READY with the size of what's kept, not of the original; files by their first bytes), and within the
 * project's quota, under the same lock as uploads from the app.
 *
 * Each copy is attached from the start: an import saves its content in later jobs, and the daily release frees any
 * that no saved content uses (packages/jobs cleanup.ts), so nothing is left for the 24-hour cleanup of unfinished
 * uploads. Saving with `attachMedia` as usual is fine too. Copies are dated before the app's hourly upload limit looks
 * (createUpload counts the uploader's last hour), so an import doesn't use up the uploads of the person who ran it.
 *
 * Network and image work: the returned function fetches, stores and processes files, outside any transaction, and
 * takes the project's row lock only to check the quota and reserve the row (as createUpload does). Never call it
 * inside a transaction holding the project lock (`lockProject`, `FOR UPDATE` on the project): it would wait on itself.
 *
 * `cache`, by the source's key: kept by the caller for a whole import, the same file is copied once. Left-out ones are
 * remembered too, so a file that's gone isn't fetched again for every post that has it.
 */
export function mediaImporter({ projectId, uploaderId, cache = new Map() }: { projectId: string; uploaderId: string; cache?: Map<string, Copied> }): MediaImporter {
  return async (source) => {
    const cached = cache.get(source.key);
    if (cached) {
      return cached;
    }
    const { passing, ...copied } = await copy(projectId, uploaderId, source);
    // A failure of our own (storage, processing) may pass: the next document tries again.
    if (!passing) {
      cache.set(source.key, copied);
    }
    return copied;
  };
}

/** More than processing ever keeps for one image (a 2400px WebP set and the email JPEG): its quota while it's processed. */
const PROCESSED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

async function copy(projectId: string, uploaderId: string, { kind, url, name }: MediaSource): Promise<Copied & { passing?: true }> {
  const storage = mediaStorage();
  if (!storage) {
    return { leftOut: "unsupported" };
  }
  let filename = kind === "file" ? attachmentName(name) : null;
  let extension = filename ? fileExtension(filename) : "";
  if (kind === "file" && !(extension in UPLOAD_FILE_TYPES)) {
    return { leftOut: "type" };
  }
  const limit = kind === "image" ? "MEDIA_MAX_IMPORT_IMAGE_MB" : kind === "video" ? "MEDIA_MAX_VIDEO_MB_TEAM" : "MEDIA_MAX_FILE_MB_TEAM";
  const body = await download(url, mediaLimit(limit));
  if (typeof body === "string") {
    return { leftOut: body };
  }
  if (kind === "file" && !isFileContent(extension, body)) {
    return { leftOut: "type" };
  }
  // A video by its content, whatever its address says; named so it's a video upload (isVideoFile).
  if (kind === "video") {
    const format = videoFormat(body);
    if (!format) {
      return { leftOut: "type" };
    }
    const named = attachmentName(name);
    filename = fileExtension(named) in UPLOAD_VIDEO_TYPES ? named : `${named.slice(0, 190)}.${format}`;
    extension = fileExtension(filename);
  }

  // An image counts at most PROCESSED_IMAGE_MAX_BYTES until it's re-encoded: what's kept (WebP sizes and the email
  // JPEG, set by processing) is always well under it, so a large original doesn't use up quota it won't keep.
  const size = kind === "image" ? Math.min(body.byteLength, PROCESSED_IMAGE_MAX_BYTES) : body.byteLength;
  const media = await prisma.$transaction(async (tx) => {
    // As createUpload (apps/web server/media.ts): one at a time per project, so nothing overruns the quota together.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
    const { _sum } = await tx.media.aggregate({ where: { projectId, status: { not: "FAILED" } }, _sum: { size: true } });
    if ((_sum.size ?? 0) + size > mediaLimit("MEDIA_PROJECT_QUOTA_MB")) {
      return null;
    }
    return tx.media.create({
      data: { projectId, uploaderId, size, filename, status: "PROCESSING", attachedAt: new Date(), createdAt: new Date(Date.now() - OUTSIDE_UPLOAD_LIMIT_MS) },
      select: { id: true },
    });
  });
  if (!media) {
    return { leftOut: "quota" };
  }

  // Refused, or storage or processing failing: left out, the row FAILED and unattached (off the quota; the cleanup
  // deletes it), so one file never fails the document it's in.
  const leaveOut = async (reason: LeftOutReason) => {
    await prisma.media.update({ where: { id: media.id }, data: { status: "FAILED", size: 0, attachedAt: null } }).catch(() => {});
    return { leftOut: reason };
  };
  try {
    if (kind === "image") {
      await storage.put(originalKey(media.id), body, "application/octet-stream");
      const processed = await imageUploaded({ mediaId: media.id }, { info: () => {}, warn: () => {} });
      if (!processed.ready) {
        return await leaveOut("type");
      }
    } else if (kind === "video") {
      await storage.put(videoKey(media.id), body, UPLOAD_VIDEO_TYPES[extension]!);
    } else {
      await storage.put(fileKey(media.id), body, UPLOAD_FILE_TYPES[extension]!);
    }
  } catch {
    return { ...(await leaveOut("unreachable")), passing: true };
  }
  const { id, ...ready } = await prisma.media.update({
    where: { id: media.id },
    data: { status: "READY", attachedAt: new Date() },
    select: { id: true, width: true, height: true, filename: true, size: true },
  });
  return { mediaId: id, ...ready };
}

/** The file at `url`, or why not: refused, unreachable, or more than `maxBytes`. */
export async function download(url: string, maxBytes: number): Promise<Uint8Array | LeftOutReason> {
  const signal = AbortSignal.timeout(timeoutFor(maxBytes));
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      await checkWebhookUrl(url);
      const response = await fetch(url, {
        redirect: "manual",
        signal,
        ...(process.env.WEBHOOK_ALLOW_PRIVATE_URLS !== "true" && { dispatcher: publicOnly }),
        headers: { "user-agent": "Tuti-Import/1" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url).href;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        return "unreachable";
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body.cancel();
        return "size";
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          return "size";
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
  } catch {
    // Refused (a private address, not https), not found, too slow.
  }
  return "unreachable";
}
