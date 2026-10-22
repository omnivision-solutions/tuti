import type { JSONContent } from "@tiptap/core";
import { imageKeysIn } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";
import { mediaStorage } from "@tuti/shared/storage";

import { appUrl } from "@/lib/hosts";
import { signForever } from "@/lib/signed";

/**
 * Where uploaded images load from. The bucket is private, so every URL is signed:
 * - `mediaUrls`, for pages: presigned storage URLs, made as the page is rendered for
 *   someone allowed to read it, that stop working within two hours (storage.ts).
 * - `lastingMediaUrl(s)`, for what outlives a page view (emails, link cards, exports):
 *   app links that send the reader on to a fresh presigned URL for as long as the
 *   image is in use (app/media/[id]/[file]). Anyone holding one can load the image,
 *   as with the email it's in.
 * Both are null when uploads aren't set up.
 */

type Docs = (JSONContent | null | undefined)[];

/** Signed URLs for the images in these documents, for a reader who may see them. */
export async function mediaUrls(...docs: Docs): Promise<MediaUrls | null> {
  const storage = mediaStorage();
  if (!storage) {
    return null;
  }
  const keys = new Set(docs.flatMap((doc) => (doc ? imageKeysIn(doc) : [])));
  return Object.fromEntries(await Promise.all([...keys].map(async (key) => [key, await storage.signedUrl(key)] as const)));
}

/** A link to a stored file (`m/<media id>/<file>`) that keeps working while the image is in use. */
export function lastingMediaUrl(key: string): string {
  const url = new URL(`/media/${key.replace(/^m\//, "")}`, appUrl());
  url.searchParams.set("s", signForever("media", key));
  return url.href;
}

export function lastingMediaUrls(...docs: Docs): MediaUrls | null {
  if (!mediaStorage()) {
    return null;
  }
  const keys = docs.flatMap((doc) => (doc ? imageKeysIn(doc) : []));
  return Object.fromEntries(keys.map((key) => [key, lastingMediaUrl(key)]));
}
