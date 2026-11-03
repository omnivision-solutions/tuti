"use server";

import {
  emailImageKey,
  fileExtension,
  fileKey,
  imageKey,
  imageWidths,
  MAX_FILE_NAME_LENGTH,
  type MediaUrls,
  originalKey,
  UPLOAD_FILE_TYPES,
  UPLOAD_IMAGE_TYPES,
} from "@tuti/content";
import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { z } from "zod";

import { attachmentName } from "./attachments";
import { canActIn } from "./membership";
import { lastingImage } from "./media-urls";
import { getSession } from "./session";

/**
 * Image uploads, straight from the browser to media storage:
 * 1. `createUpload` checks the limits and returns a presigned URL for exactly this file.
 * 2. The browser PUTs the file there, then calls `finishUpload`.
 * 3. The image job checks and re-encodes it (packages/jobs/src/images.ts).
 * 4. `uploadStatus` says when it's ready to show.
 * File attachments (articles; `name` given) are the team's only: checked by content as they finish, then
 * kept as they are, with no processing, and only ever served as downloads.
 */

const MB = 1024 * 1024;
const UPLOADS_PER_HOUR = 30;

/** Megabytes from an env var, or the default. */
function megabytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * MB;
}

const size = z.number().int().positive();
const fileSchema = z.object({
  type: z.enum(UPLOAD_IMAGE_TYPES, { error: "Only JPEG, PNG, WebP and GIF images can be uploaded" }),
  size,
});
/** A file attachment's type comes from its name (UPLOAD_FILE_TYPES), whatever the browser said. */
const attachmentSchema = z.object({ type: z.string(), size });

/** The file types an attachment may be, for errors. */
const FILE_TYPES_TEXT = "PDF, text (TXT, CSV, Markdown), JSON, ZIP, and Office or OpenDocument files";

/**
 * `file.name`: a file attachment (by its name's extension, from UPLOAD_FILE_TYPES), otherwise an image.
 * `contentType`: the type the upload is signed with, for the PUT; `name`: a file's name as kept (made safe and shortened).
 */
export async function createUpload(
  projectSlug: string,
  file: { type: string; size: number; name?: string },
): Promise<{ error: string } | { mediaId: string; uploadUrl: string; contentType: string; name?: string }> {
  const attachment = file.name !== undefined;
  const session = await getSession();
  if (!session) {
    return { error: attachment ? "Sign in to attach files" : "Sign in to upload images" };
  }
  const filename = attachment ? attachmentName(String(file.name)).slice(-MAX_FILE_NAME_LENGTH) : null;
  const fileType = filename !== null ? UPLOAD_FILE_TYPES[fileExtension(filename)] : undefined;
  if (filename !== null && !fileType) {
    return { error: `Only ${FILE_TYPES_TEXT} can be attached` };
  }
  const parsed = fileType ? attachmentSchema.safeParse({ type: fileType, size: file.size }) : fileSchema.safeParse(file);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid file" };
  }
  const contentType = parsed.data.type;
  const storage = mediaStorage();
  if (!storage) {
    return { error: attachment ? "File uploads aren't set up on this server" : "Image uploads aren't set up on this server" };
  }
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  if (!project || !(await canActIn(session.user.id, project.id))) {
    return { error: "Project not found" };
  }

  const userId = session.user.id;
  const isTeam = await prisma.teamMember.findFirst({ where: { projectId: project.id, userId }, select: { id: true } });
  // Files go into articles, which only the team writes.
  if (attachment && !isTeam) {
    return { error: "Only the team can attach files" };
  }
  const maxSize = attachment
    ? megabytes("MEDIA_MAX_FILE_MB_TEAM", 25)
    : isTeam
      ? megabytes("MEDIA_MAX_IMAGE_MB_TEAM", 10)
      : megabytes("MEDIA_MAX_IMAGE_MB_USER", 5);
  if (parsed.data.size > maxSize) {
    return { error: `${attachment ? "Files" : "Images"} can be up to ${Math.round(maxSize / MB)} MB` };
  }

  const result = await prisma.$transaction(async (tx) => {
    // One upload at a time per project, so concurrent uploads can't overrun the quota together.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR UPDATE`;
    const recent = await tx.media.count({
      where: { uploaderId: userId, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= UPLOADS_PER_HOUR) {
      return { error: `You've uploaded a lot of ${attachment ? "files" : "images"} in the last hour. Try again later.` };
    }
    const { _sum } = await tx.media.aggregate({
      where: { projectId: project.id, status: { not: "FAILED" } },
      _sum: { size: true },
    });
    if ((_sum.size ?? 0) + parsed.data.size > megabytes("MEDIA_PROJECT_QUOTA_MB", 1024)) {
      return { error: `This project has no space left for ${attachment ? "files" : "images"}` };
    }
    return tx.media.create({
      data: { projectId: project.id, uploaderId: userId, size: parsed.data.size, filename },
      select: { id: true },
    });
  });
  if ("error" in result) {
    return { error: result.error };
  }

  const uploadUrl = await storage.presignPut(originalKey(result.id), {
    contentType,
    size: parsed.data.size,
  });
  return { mediaId: result.id, uploadUrl, contentType, ...(filename !== null && { name: filename }) };
}

/** Whether a file is what its name says, by its first bytes (text: not a web page or SVG in disguise). */
function isFileContent(extension: string, bytes: Uint8Array): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const ole = () => startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // OLE compound file
  switch (extension) {
    case "pdf":
      return startsWith(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
    case "doc":
    case "xls":
    case "ppt":
      return ole();
    case "docx":
    case "xlsx":
    case "pptx":
      // ZIPs, or OLE files when they're password-protected (Office encrypts them into one).
      return startsWith(0x50, 0x4b, 0x03, 0x04) || ole();
    case "txt":
    case "csv":
    case "md":
    case "json": {
      // Any encoding (Excel saves CSV in the Windows code page, "Unicode text" as UTF-16): it's only ever
      // downloaded, so what's refused is what would read as a web page or SVG.
      const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      const text = new TextDecoder(utf16).decode(bytes.subarray(0, 2048)).replaceAll("\0", "");
      return !/^\s*<(!doctype\s+html|html|svg|script|\?xml)\b/i.test(text);
    }
    default:
      // ZIP, and Office and OpenDocument files, which are ZIPs (an empty ZIP is only an end record).
      return startsWith(0x50, 0x4b, 0x03, 0x04) || (extension === "zip" && startsWith(0x50, 0x4b, 0x05, 0x06));
  }
}

/** The browser finished uploading: check what arrived, then process it. */
export async function finishUpload(mediaId: string): Promise<{ error?: string }> {
  const session = await getSession();
  const storage = mediaStorage();
  if (!session || !storage) {
    return { error: "Upload not found" };
  }
  const media = await prisma.media.findFirst({
    where: { id: String(mediaId), uploaderId: session.user.id, status: "UPLOADING" },
    select: { id: true, size: true, filename: true },
  });
  if (!media) {
    return { error: "Upload not found" };
  }

  const key = originalKey(media.id);
  const uploaded = await storage.head(key);
  if (!uploaded) {
    return { error: "The upload didn't arrive. Try again." };
  }
  // The presigned URL only accepts the declared size; this checks storages that don't enforce it.
  if (uploaded.size !== media.size) {
    await storage.delete(key);
    await prisma.media.update({ where: { id: media.id }, data: { status: "FAILED", size: 0 } });
    return { error: "The upload didn't match the file. Try again." };
  }

  // A file attachment is kept as it is, once its content is what its name says: copied to a key the browser
  // can't write to, so the upload URL (still good for a while) can't swap the checked file for another.
  if (media.filename !== null) {
    const extension = fileExtension(media.filename);
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
        await prisma.media.update({ where: { id: media.id }, data: { status: "FAILED", size: 0 } });
        return { error };
      }
      // What's checked is `body`: a PUT to the upload since then changes nothing served. Deleted once it's copied,
      // so a failed copy can be finished again.
      await storage.put(fileKey(media.id), body, UPLOAD_FILE_TYPES[extension]!);
      await prisma.media.update({ where: { id: media.id }, data: { status: "READY" } });
    } catch (error) {
      log.error("Saving an attached file failed", { mediaId: media.id, error });
      return { error: "The file couldn't be saved. Try again." };
    }
    // Saved: a leftover upload is only tidying (deleted with the file's other keys once it's unused).
    await storage.delete(key).catch((error: unknown) => log.error("Deleting an attached file's upload failed", { mediaId: media.id, error }));
    return {};
  }

  await prisma.media.update({ where: { id: media.id }, data: { status: "PROCESSING" } });
  try {
    await enqueue("imageUploaded", { mediaId: media.id });
  } catch (error) {
    log.error("Processing an uploaded image failed", { mediaId: media.id, error });
    return { error: "The image couldn't be processed" };
  }
  return {};
}

export type UploadStatus =
  | { status: "UPLOADING" | "PROCESSING" | "FAILED" }
  | { status: "READY"; src: string; urls: MediaUrls; width: number; height: number };

/** Whether the uploader's image is ready to show, and where: `src` at full size, `urls` for every file (for the editor). */
export async function uploadStatus(mediaId: string): Promise<UploadStatus | { error: string }> {
  const session = await getSession();
  const storage = mediaStorage();
  const media =
    session &&
    (await prisma.media.findFirst({
      where: { id: String(mediaId), uploaderId: session.user.id },
      select: { id: true, status: true, width: true, height: true },
    }));
  if (!media || !storage) {
    return { error: "Upload not found" };
  }
  if (media.status === "READY" && media.width && media.height) {
    const keys = [...imageWidths(media.width).map((width) => imageKey(media.id, width)), emailImageKey(media.id)];
    const urls: MediaUrls = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await storage.signedUrl(key)])));
    return {
      status: "READY",
      src: urls[imageKey(media.id, media.width)]!,
      urls,
      width: media.width,
      height: media.height,
    };
  }
  return { status: media.status === "READY" ? "PROCESSING" : media.status };
}

/**
 * Account's avatar: the signed-in person's processed upload (a lasting link to its smallest size, so it shows
 * on every portal and in emails), or none (`null`, back to their initials).
 * ponytail: the upload belongs to the project it was made in, so leaving its team (release-media clears the photo)
 * or deleting the project takes the photo with it, and initials show again; keep avatars apart from projects if that bites.
 */
export async function setAvatar(mediaId: string | null): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to change your photo" };
  }
  if (mediaId === null) {
    await prisma.user.update({ where: { id: session.user.id }, data: { image: null, imageId: null } });
    return {};
  }
  const media = await prisma.media.findFirst({
    // An upload in a project they're on the team of: a reader's uploads stay their posts' and comments'.
    where: { id: String(mediaId), uploaderId: session.user.id, status: "READY", project: { team: { some: { userId: session.user.id } } } },
    select: { id: true, status: true, width: true, height: true },
  });
  const image = lastingImage(media);
  if (!image) {
    return { error: "Upload not found" };
  }
  await prisma.$transaction([
    prisma.media.update({ where: { id: image.id }, data: { attachedAt: new Date() } }),
    prisma.user.update({ where: { id: session.user.id }, data: { image: image.url, imageId: image.id } }),
  ]);
  return {};
}
