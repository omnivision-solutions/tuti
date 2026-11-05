import type { ImportedMedia, LeftOutReason, MediaImporter, MediaSource } from "@tuti/content/html";
import { attachmentName, fileExtension, fileKey, isFileContent, originalKey, UPLOAD_FILE_TYPES } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { mediaLimit, mediaStorage } from "@tuti/shared/storage";
import { checkWebhookUrl, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import { imageUploaded } from "./images";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });
const MAX_REDIRECTS = 3;
/** For one download, body and all. */
const TIMEOUT_MS = 30_000;

type Copied = ImportedMedia | { leftOut: LeftOutReason };

/**
 * Copies images and files from another tool into a project's media (imports: `htmlToContent`'s `media`), as uploads
 * by `uploaderId`: fetched like webhooks (public addresses only, each redirect checked again, a time limit), up to the
 * upload limit for their kind (read while streaming), checked by content (images re-encoded at once by the image
 * job's own processing, so they're READY with their size; files by their first bytes), and within the project's
 * quota, under the same lock as uploads from the app. The app's hourly upload limit doesn't apply.
 *
 * Each copy is marked attached when it's READY: an import saves its content in later jobs, and the daily release
 * frees any that no saved content uses (packages/jobs cleanup.ts), so nothing is left for the 24-hour cleanup of
 * unfinished uploads. Saving with `attachMedia` as usual is fine too.
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
    const copied = await copy(projectId, uploaderId, source);
    cache.set(source.key, copied);
    return copied;
  };
}

async function copy(projectId: string, uploaderId: string, { kind, url, name }: MediaSource): Promise<Copied> {
  const storage = mediaStorage();
  if (!storage) {
    return { leftOut: "unsupported" };
  }
  const filename = kind === "file" ? attachmentName(name) : null;
  const extension = filename ? fileExtension(filename) : "";
  if (kind === "file" && !(extension in UPLOAD_FILE_TYPES)) {
    return { leftOut: "type" };
  }
  const body = await download(url, mediaLimit(kind === "image" ? "MEDIA_MAX_IMAGE_MB_TEAM" : "MEDIA_MAX_FILE_MB_TEAM"));
  if (typeof body === "string") {
    return { leftOut: body };
  }
  if (kind === "file" && !isFileContent(extension, body)) {
    return { leftOut: "type" };
  }

  const media = await prisma.$transaction(async (tx) => {
    // As createUpload (apps/web server/media.ts): one at a time per project, so nothing overruns the quota together.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
    const { _sum } = await tx.media.aggregate({ where: { projectId, status: { not: "FAILED" } }, _sum: { size: true } });
    if ((_sum.size ?? 0) + body.byteLength > mediaLimit("MEDIA_PROJECT_QUOTA_MB")) {
      return null;
    }
    return tx.media.create({ data: { projectId, uploaderId, size: body.byteLength, filename, status: "PROCESSING" }, select: { id: true } });
  });
  if (!media) {
    return { leftOut: "quota" };
  }

  // Should storage fail, the row (never attached) goes with the hourly cleanup a day later.
  if (kind === "image") {
    await storage.put(originalKey(media.id), body, "application/octet-stream");
    const processed = await imageUploaded({ mediaId: media.id }, { info: () => {}, warn: () => {} });
    if (!processed.ready) {
      return { leftOut: "type" };
    }
  } else {
    await storage.put(fileKey(media.id), body, UPLOAD_FILE_TYPES[extension]!);
  }
  const { id, ...ready } = await prisma.media.update({
    where: { id: media.id },
    data: { status: "READY", attachedAt: new Date() },
    select: { id: true, width: true, height: true, filename: true, size: true },
  });
  return { mediaId: id, ...ready };
}

/** The file at `url`, or why not: refused, unreachable, or more than `maxBytes`. */
async function download(url: string, maxBytes: number): Promise<Uint8Array | LeftOutReason> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
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
