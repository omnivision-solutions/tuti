import { imageKeysIn, type MediaUrls } from "@tuti/content";
import { lastingMediaUrl } from "@tuti/shared/media-links";
import { mediaStorage } from "@tuti/shared/storage";

export { lastingMediaUrl };

/** Lasting links for the images in these documents; null when uploads aren't set up. */
export function lastingMediaUrls(...docs: (Parameters<typeof imageKeysIn>[0] | null | undefined)[]): MediaUrls | null {
  if (!mediaStorage()) {
    return null;
  }
  const keys = docs.flatMap((doc) => (doc ? imageKeysIn(doc) : []));
  return Object.fromEntries(keys.map((key) => [key, lastingMediaUrl(key)]));
}
