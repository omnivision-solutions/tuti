import { signForever } from "./signed";

/**
 * Lasting links to uploaded images, for what outlives a page view (emails, link cards, exports, profile pictures):
 * app links (APP_URL) that send the reader on to a fresh presigned URL for as long as the image is in use
 * (apps/web app/api/media/[id]/[file], which checks the signature). Anyone holding one can load the image, as with
 * the email it's in.
 */

/**
 * A stored file (`m/<media id>/<file>`) with its signature, as a profile picture is saved (`user.image`): no host or
 * path, so the link is made when it's read (pictureUrl) and follows APP_URL and the route.
 */
export function savedPicture(key: string): string {
  return `${key}?s=${signForever("media", key)}`;
}

const SAVED = /^m\/[a-z0-9]+\/[^/?]+\?s=[\w-]+$/;

/**
 * A saved picture as a link: an upload's (savedPicture) made now; one from elsewhere (a sign-in provider, SSO) as it
 * is. Without APP_URL (a worker may have none) an upload's is no picture: reading a user never fails for it.
 */
export function pictureUrl(saved: string | null): string | null {
  if (!saved || !SAVED.test(saved)) {
    return saved;
  }
  return process.env.APP_URL ? new URL(`/api/media/${saved.slice("m/".length)}`, process.env.APP_URL).href : null;
}

/** A link to a stored file (`m/<media id>/<file>`) that keeps working while the image is in use. */
export function lastingMediaUrl(key: string): string {
  if (!process.env.APP_URL) {
    throw new Error("Lasting media links need APP_URL");
  }
  return pictureUrl(savedPicture(key))!;
}
