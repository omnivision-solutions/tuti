"use server";

import { imageKey, originalKey, UPLOAD_IMAGE_TYPES } from "@tuti/content";
import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { z } from "zod";

import { canActIn } from "./membership";
import { getSession } from "./session";

/**
 * Image uploads, straight from the browser to media storage:
 * 1. `createUpload` checks the limits and returns a presigned URL for exactly this file.
 * 2. The browser PUTs the file there, then calls `finishUpload`.
 * 3. The image job checks and re-encodes it (packages/jobs/src/images.ts).
 * 4. `uploadStatus` says when it's ready to show.
 */

const MB = 1024 * 1024;
const UPLOADS_PER_HOUR = 30;

/** Megabytes from an env var, or the default. */
function megabytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * MB;
}

const fileSchema = z.object({
  type: z.enum(UPLOAD_IMAGE_TYPES, { error: "Only JPEG, PNG, WebP and GIF images can be uploaded" }),
  size: z.number().int().positive(),
});

export async function createUpload(
  projectSlug: string,
  file: { type: string; size: number },
): Promise<{ error: string } | { mediaId: string; uploadUrl: string }> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to upload images" };
  }
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid file" };
  }
  const storage = mediaStorage();
  if (!storage) {
    return { error: "Image uploads aren't set up on this server" };
  }
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  if (!project || !(await canActIn(session.user.id, project.id))) {
    return { error: "Project not found" };
  }

  const userId = session.user.id;
  const isTeam = await prisma.teamMember.findFirst({ where: { projectId: project.id, userId }, select: { id: true } });
  const maxSize = isTeam ? megabytes("MEDIA_MAX_IMAGE_MB_TEAM", 10) : megabytes("MEDIA_MAX_IMAGE_MB_USER", 5);
  if (parsed.data.size > maxSize) {
    return { error: `Images can be up to ${Math.round(maxSize / MB)} MB` };
  }

  const result = await prisma.$transaction(async (tx) => {
    // One upload at a time per project, so concurrent uploads can't overrun the quota together.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR UPDATE`;
    const recent = await tx.media.count({
      where: { uploaderId: userId, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= UPLOADS_PER_HOUR) {
      return { error: "You've uploaded a lot of images in the last hour. Try again later." };
    }
    const { _sum } = await tx.media.aggregate({
      where: { projectId: project.id, status: { not: "FAILED" } },
      _sum: { size: true },
    });
    if ((_sum.size ?? 0) + parsed.data.size > megabytes("MEDIA_PROJECT_QUOTA_MB", 1024)) {
      return { error: "This project has no space left for images" };
    }
    return tx.media.create({
      data: { projectId: project.id, uploaderId: userId, size: parsed.data.size },
      select: { id: true },
    });
  });
  if ("error" in result) {
    return { error: result.error };
  }

  const uploadUrl = await storage.presignPut(originalKey(result.id), {
    contentType: parsed.data.type,
    size: parsed.data.size,
  });
  return { mediaId: result.id, uploadUrl };
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
    select: { id: true, size: true },
  });
  if (!media) {
    return { error: "Upload not found" };
  }

  const uploaded = await storage.head(originalKey(media.id));
  if (!uploaded) {
    return { error: "The upload didn't arrive. Try again." };
  }
  // The presigned URL only accepts the declared size; this checks storages that don't enforce it.
  if (uploaded.size !== media.size) {
    await storage.delete(originalKey(media.id));
    await prisma.media.update({ where: { id: media.id }, data: { status: "FAILED", size: 0 } });
    return { error: "The upload didn't match the file. Try again." };
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
  | { status: "READY"; src: string; width: number; height: number };

/** Whether the uploader's image is ready to show, and where. */
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
    return {
      status: "READY",
      src: storage.publicUrl(imageKey(media.id, media.width)),
      width: media.width,
      height: media.height,
    };
  }
  return { status: media.status === "READY" ? "PROCESSING" : media.status };
}
