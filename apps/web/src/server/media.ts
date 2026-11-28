"use server";

import { imageKey, imageWidths } from "@tuti/content";
import { prisma } from "@tuti/db";
import { savedPicture } from "@tuti/shared/media-links";

import { lastingImage } from "./media-urls";
import { getAccountSession } from "./session";

/**
 * Account's avatar: the signed-in person's processed upload (a lasting link to its smallest size, so it shows
 * on every portal and in emails), or none (`null`, back to their initials).
 * ponytail: the upload belongs to the project it was made in, so leaving its team (release-media clears the photo)
 * or deleting the project takes the photo with it, and initials show again; keep avatars apart from projects if that bites.
 */
export async function setAvatar(mediaId: string | null): Promise<{ error?: string }> {
  const session = await getAccountSession();
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
    // Its stored file, not a link: the link is made when it's read (@tuti/db), so it follows APP_URL and the route.
    prisma.user.update({ where: { id: session.user.id }, data: { image: savedPicture(imageKey(image.id, imageWidths(image.width)[0]!)), imageId: image.id } }),
  ]);
  return {};
}
