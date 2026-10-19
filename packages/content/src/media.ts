/**
 * Where processed images live in media storage and which sizes exist, shared by
 * the image job (which writes them) and the renderers (which build srcset).
 */

/** Longest side after processing. */
export const MAX_IMAGE_SIZE = 2400;
const IMAGE_WIDTHS = [480, 960, 1600];
/** Emails get one JPEG (WebP support in mail clients is patchy). */
export const EMAIL_IMAGE_WIDTH = 1200;

/** The WebP widths stored for an image `width` pixels wide (after processing): the standard ones below it, plus its own. */
export function imageWidths(width: number): number[] {
  return [...IMAGE_WIDTHS.filter((w) => w < width), width];
}

export const originalKey = (mediaId: string) => `uploads/${mediaId}`;
export const imageKey = (mediaId: string, width: number) => `m/${mediaId}/${width}.webp`;
export const emailImageKey = (mediaId: string) => `m/${mediaId}/email.jpg`;

/** Formats people may upload; everything is re-encoded, and SVG (which can carry scripts) is never accepted. */
export const UPLOAD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
