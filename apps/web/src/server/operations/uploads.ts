import {
  attachmentName,
  emailImageKey,
  fileExtension,
  fileKey,
  imageKey,
  imageWidths,
  isFileContent,
  isVideoFile,
  MAX_FILE_NAME_LENGTH,
  type MediaUrls,
  originalKey,
  UPLOAD_FILE_TYPES,
  UPLOAD_IMAGE_TYPES,
  UPLOAD_VIDEO_TYPES,
  videoKey,
  videoType,
} from "@tuti/content";
import { prisma } from "@tuti/db";
import { enqueue, UPLOADS_PER_HOUR_TEAM } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { mediaLimit, mediaStorage, VIDEO_URL_SECONDS } from "@tuti/shared/storage";
import { z } from "zod";

import { onTeam } from "../session";
import { type Actor, defineOperation, OperationError } from "./define";

/**
 * Image uploads, straight from the browser to media storage (internal: the app's and portals' own, never the API's):
 * 1. `uploads.create` checks the limits and returns a presigned URL for exactly this file.
 * 2. The browser PUTs the file there, then calls `uploads.finish`.
 * 3. The image job checks and re-encodes it (packages/jobs/src/images.ts).
 * 4. `uploads.status` says when it's ready to show.
 * File attachments (articles; `name` given) are the team's only: checked by content as they finish, then
 * kept as they are, with no processing, and only ever served as downloads. Videos (articles; a file named .mp4, .webm or
 * .mov) go the same way, copied by the storage itself and checked there, and are played in place with their video type.
 * Anyone who may act in the project uploads (`access: "anyone"`: the team, or a portal's reader on that portal); a key never does.
 */

const MB = 1024 * 1024;
/** Portal users add a picture or two to a post; a team member (UPLOADS_PER_HOUR_TEAM) writing docs adds dozens in a sitting. The project's quota bounds both. */
const UPLOADS_PER_HOUR = 30;

const size = z.number().int().positive({ error: "This file is empty" });
const fileSchema = z.object({
  type: z.enum(UPLOAD_IMAGE_TYPES, { error: "Only JPEG, PNG, WebP and GIF images can be uploaded" }),
  size,
});
/** A file attachment's type comes from its name (UPLOAD_FILE_TYPES), whatever the browser said. */
const attachmentSchema = z.object({ type: z.string(), size });

/** The file types an attachment may be, for errors. */
const FILE_TYPES_TEXT = "PDF, text (TXT, CSV, Markdown), JSON, ZIP, Office or OpenDocument files, and MP4, WebM or MOV videos";

/** The person uploading: never a key (uploads are a person's, counted per uploader). */
function uploader(actor: Actor) {
  if (actor.kind !== "user") {
    throw new OperationError(403, "people_only", "Only a signed-in person uploads");
  }
  return actor.userId;
}

const mediaId = z.string().trim().min(1).max(100);

export const createUpload = defineOperation({
  name: "uploads.create",
  title: "Start an upload",
  summary: "Start uploading an image, or with `name` a file for an article: where to PUT exactly this file.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "anyone",
  input: z.object({ type: z.string().max(200), size: z.number(), name: z.string().max(10_000).optional() }),
  output: z.object({ mediaId: z.string(), uploadUrl: z.string(), contentType: z.string(), name: z.string().optional() }),
  // `name`: a file attachment (by its extension, from UPLOAD_FILE_TYPES), otherwise an image. `contentType`: the type
  // the upload is signed with, for the PUT; `name` back: the file's name as kept (made safe and shortened).
  run: async ({ actor, projectId }, file) => {
    const userId = uploader(actor);
    const attachment = file.name !== undefined;
    const filename = attachment ? attachmentName(String(file.name)).slice(-MAX_FILE_NAME_LENGTH) : null;
    const video = isVideoFile(filename);
    const fileType = filename !== null ? (UPLOAD_FILE_TYPES[fileExtension(filename)] ?? UPLOAD_VIDEO_TYPES[fileExtension(filename)]) : undefined;
    if (filename !== null && !fileType) {
      throw new OperationError(400, "invalid_input", `Only ${FILE_TYPES_TEXT} can be attached`);
    }
    const parsed = fileType ? attachmentSchema.safeParse({ type: fileType, size: file.size }) : fileSchema.safeParse(file);
    if (!parsed.success) {
      throw new OperationError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid file");
    }
    const contentType = parsed.data.type;
    const storage = mediaStorage();
    if (!storage) {
      throw new OperationError(503, "uploads_unavailable", attachment ? "File uploads aren't set up on this server" : "Image uploads aren't set up on this server");
    }

    // The team as this request has them: a teammate on a portal's session uploads as a reader.
    const isTeam = await onTeam(projectId, userId);
    // Files go into articles, which only the team writes.
    if (attachment && !isTeam) {
      throw new OperationError(403, "forbidden", "Only the team can attach files");
    }
    const maxSize = video ? mediaLimit("teamVideo") : attachment ? mediaLimit("teamFile") : isTeam ? mediaLimit("teamImage") : mediaLimit("userImage");
    if (parsed.data.size > maxSize) {
      throw new OperationError(400, "invalid_input", `${video ? "Videos" : attachment ? "Files" : "Images"} can be up to ${Math.round(maxSize / MB)} MB`);
    }

    const result = await prisma.$transaction(async (tx) => {
      // One upload at a time per project, so concurrent uploads can't overrun the quota together.
      await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR UPDATE`;
      const recent = await tx.media.count({
        where: { uploaderId: userId, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
      });
      if (recent >= (isTeam ? UPLOADS_PER_HOUR_TEAM : UPLOADS_PER_HOUR)) {
        return new OperationError(429, "rate_limited", `You've uploaded a lot of ${attachment ? "files" : "images"} in the last hour. Try again later.`);
      }
      const { _sum } = await tx.media.aggregate({
        where: { projectId, status: { not: "FAILED" } },
        _sum: { size: true },
      });
      if ((_sum.size ?? 0) + parsed.data.size > mediaLimit("projectQuota")) {
        return new OperationError(409, "no_room", `This project has no space left for ${attachment ? "files" : "images"}`);
      }
      return tx.media.create({
        data: { projectId, uploaderId: userId, size: parsed.data.size, filename },
        select: { id: true },
      });
    });
    if (result instanceof OperationError) {
      throw result;
    }

    const uploadUrl = await storage.presignPut(originalKey(result.id), {
      contentType,
      size: parsed.data.size,
    });
    return { mediaId: result.id, uploadUrl, contentType, ...(filename !== null && { name: filename }) };
  },
});

export const finishUpload = defineOperation({
  name: "uploads.finish",
  title: "Finish an upload",
  summary: "The file is in storage: check what arrived, then process it. A video's `src` is where the editor plays it from, for a day.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "anyone",
  input: z.object({ mediaId }),
  output: z.object({ src: z.string().optional() }),
  run: async ({ actor, projectId }, input) => {
    const userId = uploader(actor);
    const storage = mediaStorage();
    const media =
      storage &&
      (await prisma.media.findFirst({
        where: { id: input.mediaId, projectId, uploaderId: userId, status: "UPLOADING" },
        select: { id: true, size: true, filename: true },
      }));
    if (!storage || !media) {
      throw new OperationError(404, "not_found", "Upload not found");
    }

    const key = originalKey(media.id);
    const uploaded = await storage.head(key);
    if (!uploaded) {
      throw new OperationError(400, "upload_failed", "The upload didn't arrive. Try again.");
    }
    // Each outcome only from UPLOADING: of two finishes at once, the first to land decides (a refusal can't leave a
    // file another finish kept READY with no size in the quota, nor undo it).
    const settle = (data: { status: "READY" | "FAILED" | "PROCESSING"; size?: number }) =>
      prisma.media.updateMany({ where: { id: media.id, status: "UPLOADING" }, data });
    // The presigned URL only accepts the declared size; this checks storages that don't enforce it.
    if (uploaded.size !== media.size) {
      await storage.delete(key);
      await settle({ status: "FAILED", size: 0 });
      throw new OperationError(400, "upload_failed", "The upload didn't match the file. Try again.");
    }

    // A video is copied by the storage (too big to pass through here) to a key the browser can't write to, as the type
    // its first bytes say (videoType), then the copy is checked: its size, and that its first bytes are a video's of that
    // type. Claimed first, so of two finishes at once only one copies.
    if (isVideoFile(media.filename)) {
      if ((await settle({ status: "PROCESSING" })).count === 0) {
        const now = await prisma.media.findUnique({ where: { id: media.id }, select: { status: true } });
        if (now?.status !== "READY") {
          throw new OperationError(400, "upload_failed", "The upload didn't match the file. Try again.");
        }
        return { src: await storage.signedUrl(videoKey(media.id), undefined, undefined, VIDEO_URL_SECONDS) };
      }
      const fail = async (error: string) => {
        await storage.delete(videoKey(media.id)).catch(() => {});
        await storage.delete(key).catch(() => {});
        await prisma.media.updateMany({ where: { id: media.id, status: "PROCESSING" }, data: { status: "FAILED", size: 0 } });
        return new OperationError(400, "upload_failed", error);
      };
      try {
        const type = videoType(await storage.get(key, 16));
        if (!type) {
          throw await fail(`${media.filename} isn't a video`);
        }
        await storage.copy(key, videoKey(media.id), type);
        const copied = await storage.head(videoKey(media.id));
        if (copied?.size !== media.size) {
          throw await fail("The upload didn't match the file. Try again.");
        }
        if (videoType(await storage.get(videoKey(media.id), 16)) !== type) {
          throw await fail(`${media.filename} isn't a video`);
        }
        await prisma.media.updateMany({ where: { id: media.id, status: "PROCESSING" }, data: { status: "READY" } });
      } catch (error) {
        if (error instanceof OperationError) {
          throw error;
        }
        log.error("Saving an uploaded video failed", { mediaId: media.id, error });
        throw await fail("The video couldn't be saved. Try again.");
      }
      await storage.delete(key).catch((error: unknown) => log.error("Deleting a video's upload failed", { mediaId: media.id, error }));
      return { src: await storage.signedUrl(videoKey(media.id), undefined, undefined, VIDEO_URL_SECONDS) };
    }

    // A file attachment is kept as it is, once its content is what its name says: copied to a key the browser
    // can't write to, so the upload URL (still good for a while) can't swap the checked file for another.
    if (media.filename !== null) {
      const extension = fileExtension(media.filename);
      let claimed = false;
      try {
        // At most one byte more than declared: enough to tell it's been swapped for a bigger one, without reading it all.
        const body = await storage.get(key, media.size + 1);
        // The size again: the upload URL may have replaced the file since the check above, on storage that doesn't
        // hold a PUT to its signed size.
        const error =
          body.byteLength !== media.size
            ? "The upload didn't match the file. Try again."
            : !isFileContent(extension, body)
              ? `${media.filename} isn't a ${extension.toUpperCase()} file`
              : null;
        if (error) {
          await storage.delete(key);
          await settle({ status: "FAILED", size: 0 });
          throw new OperationError(400, "upload_failed", error);
        }
        // Claimed before the copy, so of two finishes at once only one writes the file; the other is done if that
        // one kept it.
        claimed = (await settle({ status: "PROCESSING" })).count > 0;
        if (!claimed) {
          const now = await prisma.media.findUnique({ where: { id: media.id }, select: { status: true } });
          if (now?.status !== "READY") {
            throw new OperationError(400, "upload_failed", "The upload didn't match the file. Try again.");
          }
          return {};
        }
        // What's checked is `body`: a PUT to the upload since then changes nothing served. Deleted once it's copied.
        await storage.put(fileKey(media.id), body, UPLOAD_FILE_TYPES[extension]!);
        // From this finish's own claim only.
        await prisma.media.updateMany({ where: { id: media.id, status: "PROCESSING" }, data: { status: "READY" } });
      } catch (error) {
        if (error instanceof OperationError) {
          throw error;
        }
        // A copy that failed gives its claim back (never another finish's), so finishing again works.
        if (claimed) {
          await prisma.media.updateMany({ where: { id: media.id, status: "PROCESSING" }, data: { status: "UPLOADING" } });
        }
        log.error("Saving an attached file failed", { mediaId: media.id, error });
        throw new OperationError(503, "unavailable", "The file couldn't be saved. Try again.");
      }
      // Saved: a leftover upload is only tidying (deleted with the file's other keys once it's unused).
      await storage.delete(key).catch((error: unknown) => log.error("Deleting an attached file's upload failed", { mediaId: media.id, error }));
      return {};
    }

    // Claimed, as files and videos are: of two finishes at once only one queues the image job, and neither undoes the
    // other's outcome. The other is done if that one's claim stands, else told what went wrong.
    if ((await settle({ status: "PROCESSING" })).count === 0) {
      const now = await prisma.media.findUnique({ where: { id: media.id }, select: { status: true } });
      if (now?.status === "FAILED") {
        throw new OperationError(400, "upload_failed", "The upload didn't match the file. Try again.");
      }
      return {};
    }
    try {
      await enqueue("imageUploaded", { mediaId: media.id });
    } catch (error) {
      log.error("Processing an uploaded image failed", { mediaId: media.id, error });
      throw new OperationError(503, "unavailable", "The image couldn't be processed");
    }
    return {};
  },
});

const urls = z.record(z.string(), z.string());

export const getUploadStatus = defineOperation({
  name: "uploads.status",
  title: "Get an upload's status",
  summary: "Whether the uploader's image is ready to show, and where: `src` at full size, `urls` for every file (for the editor), `download` to save it.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "anyone",
  input: z.object({ mediaId }),
  // READY with where to show it; else only the status.
  output: z.object({
    status: z.enum(["UPLOADING", "PROCESSING", "FAILED", "READY"]),
    src: z.string().optional(),
    urls: urls.optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    download: z.string().optional(),
  }),
  run: async ({ actor, projectId }, input) => {
    const userId = uploader(actor);
    const storage = mediaStorage();
    const media =
      storage &&
      (await prisma.media.findFirst({
        where: { id: input.mediaId, projectId, uploaderId: userId },
        select: { id: true, status: true, width: true, height: true },
      }));
    if (!storage || !media) {
      throw new OperationError(404, "not_found", "Upload not found");
    }
    if (media.status === "READY" && media.width && media.height) {
      const keys = [...imageWidths(media.width).map((width) => imageKey(media.id, width)), emailImageKey(media.id)];
      const signed: MediaUrls = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await storage.signedUrl(key)])));
      return {
        status: "READY" as const,
        src: signed[imageKey(media.id, media.width)]!,
        urls: signed,
        width: media.width,
        height: media.height,
        download: await storage.signedUrl(imageKey(media.id, media.width), undefined, "image.webp"),
      };
    }
    return { status: media.status === "READY" ? ("PROCESSING" as const) : media.status };
  },
});
