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
/** A file attachment (articles), kept as uploaded: only ever served as a download. */
export const fileKey = (mediaId: string) => `m/${mediaId}/file`;
/** An uploaded video (articles), kept as uploaded (no transcoding): played from its signed URL with its video type. */
export const videoKey = (mediaId: string) => `m/${mediaId}/video`;

/** URLs to load stored files from, by key: the bucket is private, so the server signs one per file (apps/web server/media-urls.ts). */
export type MediaUrls = Record<string, string>;

/** Every file an upload may have in storage (the original until processed, then its sizes). */
export function mediaKeys(media: { id: string; width: number | null }): string[] {
  const sizes = media.width ? imageWidths(media.width).map((width) => imageKey(media.id, width)) : [];
  return [originalKey(media.id), ...sizes, emailImageKey(media.id), fileKey(media.id), videoKey(media.id)];
}

/** Formats people may upload; everything is re-encoded, and SVG (which can carry scripts) is never accepted. */
export const UPLOAD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Files the team may attach to articles, by extension: documents only, never HTML, SVG, scripts or
 * programs. The type is the one the upload is signed with; the server checks the content too
 * (apps/web server/media.ts). Each is served as a download, never shown on the storage's host.
 */
export const UPLOAD_FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

/**
 * Videos the team may upload into articles, by extension: uploaded like file attachments (a file named so is a
 * video), checked by content, then played in place with a native player, never re-encoded.
 */
export const UPLOAD_VIDEO_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

/** Whether an upload's file name makes it a video (UPLOAD_VIDEO_TYPES). */
export const isVideoFile = (name: string | null | undefined) => !!name && fileExtension(name) in UPLOAD_VIDEO_TYPES;

/** A video's format by its first bytes ("mp4" for any ISO media file, "mov" for QuickTime's), or null if it's none. */
export function videoFormat(bytes: Uint8Array): "mp4" | "mov" | "webm" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm"; // EBML (WebM, Matroska)
  }
  if (ascii(4, 8) === "ftyp") {
    return ascii(8, 12) === "qt  " ? "mov" : "mp4";
  }
  // Older QuickTime files start with a movie or data atom instead.
  return ["moov", "mdat", "wide", "free", "skip"].includes(ascii(4, 8)) ? "mov" : null;
}

/** A file name's extension, lower case ("Report.PDF" → "pdf"), or "" without one. */
export const fileExtension = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/** "12 KB", "1.5 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether a file is what its name says, by its first bytes (text: not a web page or SVG in disguise). */
export function isFileContent(extension: string, bytes: Uint8Array): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const ole = () => startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // OLE compound file
  switch (extension) {
    case "mp4":
    case "mov":
    case "webm":
      // Any of them: browsers play the content, whatever the name says (a .mov is often an MP4).
      return videoFormat(bytes) !== null;
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

/** A name that's safe to show and to save as: no path, no control characters, not too long. */
export function attachmentName(name: string | undefined) {
  const base = (name ?? "").split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(-200) || "attachment";
}
