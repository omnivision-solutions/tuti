import { imageKeysIn, type MediaUrls } from "@tuti/content";
import { signForever } from "@tuti/shared/signed";
import { mediaStorage } from "@tuti/shared/storage";

/**
 * Lasting links to uploaded images, for what outlives a page view (emails, link cards, exports): app links
 * (APP_URL) that send the reader on to a fresh presigned URL for as long as the image is in use
 * (apps/web app/media/[id]/[file]). Anyone holding one can load the image, as with the email it's in.
 */

/** A link to a stored file (`m/<media id>/<file>`) that keeps working while the image is in use. */
export function lastingMediaUrl(key: string): string {
  if (!process.env.APP_URL) {
    throw new Error("Lasting media links need APP_URL");
  }
  const url = new URL(`/media/${key.replace(/^m\//, "")}`, process.env.APP_URL);
  url.searchParams.set("s", signForever("media", key));
  return url.href;
}

/** Lasting links for the images in these documents; null when uploads aren't set up. */
export function lastingMediaUrls(...docs: (Parameters<typeof imageKeysIn>[0] | null | undefined)[]): MediaUrls | null {
  if (!mediaStorage()) {
    return null;
  }
  const keys = docs.flatMap((doc) => (doc ? imageKeysIn(doc) : []));
  return Object.fromEntries(keys.map((key) => [key, lastingMediaUrl(key)]));
}
