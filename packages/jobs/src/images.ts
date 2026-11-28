import { emailImageKey, EMAIL_IMAGE_WIDTH, imageKey, imageWidths, MAX_IMAGE_SIZE, originalKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import sharp from "sharp";

import type { JobLogger, JobResult } from "./index";

/** Formats sharp may read uploads as; anything else (SVG, PDF, HEIC, …) is refused. */
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);
/** Refuse images that would take too much memory to decode (a "pixel bomb"). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * After an image is uploaded: check it really is an image we accept (by its
 * content, not its name or declared type), then re-encode it. Re-encoding drops
 * all metadata (EXIF, including location) and anything hidden in the file. Keeps
 * WebP sizes for pages and a JPEG for email, then deletes the original.
 */
export async function imageUploaded(input: JobInput<"imageUploaded">, log: JobLogger): Promise<JobResult> {
  const media = await prisma.media.findUnique({ where: { id: input.mediaId }, select: { id: true, status: true } });
  if (media?.status !== "PROCESSING") {
    log.warn(`media ${input.mediaId} isn't waiting to be processed, skipping`);
    return { skipped: true };
  }
  const storage = mediaStorage();
  if (!storage) {
    throw new Error("Media storage isn't configured");
  }

  const original = originalKey(media.id);
  try {
    const file = await storage.get(original);
    const metadata = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
      throw new RefusedImage(`format ${metadata.format ?? "unknown"}`);
    }

    // Upright (EXIF orientation applied), at most MAX_IMAGE_SIZE on its longest side.
    // ponytail: animated GIFs keep their first frame only; keep animation if people ask.
    const base = sharp(file, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_IMAGE_SIZE, height: MAX_IMAGE_SIZE, fit: "inside", withoutEnlargement: true });
    const { data: largest, info } = await base.clone().webp({ quality: 82 }).toBuffer({ resolveWithObject: true });

    const files: { key: string; body: Uint8Array; type: string }[] = [];
    for (const width of imageWidths(info.width)) {
      const body = width === info.width ? largest : await base.clone().resize({ width }).webp({ quality: 82 }).toBuffer();
      files.push({ key: imageKey(media.id, width), body, type: "image/webp" });
    }
    const email = await base
      .clone()
      .resize({ width: Math.min(info.width, EMAIL_IMAGE_WIDTH) })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    files.push({ key: emailImageKey(media.id), body: email, type: "image/jpeg" });

    for (const f of files) {
      await storage.put(f.key, f.body, f.type);
    }
    const size = files.reduce((sum, f) => sum + f.body.byteLength, 0);
    // Only from PROCESSING: a job queued twice may run twice at once, and the first to finish decides. Ready before the
    // original goes, so a second run that then can't read it finds this one's outcome.
    const { count } = await prisma.media.updateMany({
      where: { id: media.id, status: "PROCESSING" },
      data: { status: "READY", width: info.width, height: info.height, size },
    });
    if (count === 0) {
      // Another run settled it first. Never delete while it's PROCESSING or UPLOADING again (a retried finish's run may
      // be writing these same keys). Gone or FAILED, nothing here is anyone's; READY, only what isn't among its own
      // files (keys come from the id and widths, so smaller widths and the email copy may be shared).
      const settled = await prisma.media.findUnique({ where: { id: media.id }, select: { status: true, width: true } });
      if (!settled || settled.status === "FAILED" || (settled.status === "READY" && settled.width)) {
        const kept = new Set(settled?.status === "READY" && settled.width ? [...imageWidths(settled.width).map((width) => imageKey(media.id, width)), emailImageKey(media.id)] : []);
        await Promise.all(files.filter((f) => !kept.has(f.key)).map((f) => storage.delete(f.key).catch(() => {})));
      }
      log.warn(`media ${media.id} was settled by another run, skipping`);
      return { skipped: true };
    }
    await storage.delete(original).catch((error: unknown) => log.warn(`media ${media.id}: deleting its original failed: ${String(error)}`));
    log.info(`media ${media.id}: ${info.width}x${info.height}, ${files.length} files, ${size} bytes`);
    return { ready: true, width: info.width, height: info.height, files: files.length };
  } catch (error) {
    // Another run of this job finished first (and deleted the original this one couldn't read): its outcome stands.
    const now = await prisma.media.findUnique({ where: { id: media.id }, select: { status: true } });
    if (now?.status !== "PROCESSING") {
      log.warn(`media ${media.id} was settled by another run, skipping`);
      return { skipped: true };
    }
    // Not an image we take (or broken): nothing is kept, and it stops counting against the quota.
    await storage.delete(original);
    await prisma.media.updateMany({ where: { id: media.id, status: "PROCESSING" }, data: { status: "FAILED", size: 0 } });
    if (error instanceof RefusedImage || isUnreadableImage(error)) {
      log.warn(`media ${media.id} refused: ${(error as Error).message}`);
      return { ready: false };
    }
    throw error;
  }
}

class RefusedImage extends Error {}

/** sharp's errors for files it can't decode or that are too big. */
function isUnreadableImage(error: unknown): boolean {
  return error instanceof Error && /unsupported image format|Input buffer|pixel limit|corrupt|VipsJpeg|pngload|webpload|gifload/i.test(error.message);
}
