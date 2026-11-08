import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { AwsClient } from "aws4fetch";

/**
 * Media storage: any S3-compatible bucket (R2 on tuti.so), set up with `MEDIA_*`
 * env vars. The bucket is private: browsers upload to it and load files from it
 * only with presigned URLs, on the storage's own host, which never gets Tuti's
 * session cookies.
 */
export type MediaStorage = {
  /** A URL the browser can PUT exactly this file to (type and size are part of the signature). */
  presignPut(key: string, file: { contentType: string; size: number }, expiresInSeconds?: number): Promise<string>;
  /** The object's size, or null if it isn't there. */
  head(key: string): Promise<{ size: number } | null>;
  /** The object's bytes, at most `maxBytes` of them when given (a ranged GET). */
  get(key: string, maxBytes?: number): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** `put` of a file on disk, streamed (a video: never whole in memory); `signal` cuts it off, retries and all. */
  putFile(key: string, path: string, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Copies an object within the bucket (the storage does it: the bytes never pass through here), as this type. */
  copy(from: string, to: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * A URL that reads the file for a while (see SIGNED_WINDOW_SECONDS). With `download`, the browser
   * saves it under that name instead of showing it (any file someone sent: never rendered on the host). `lasts`: for at
   * least this many seconds after it's made, not the usual window (VIDEO_URL_SECONDS).
   */
  signedUrl(key: string, now?: number, download?: string, lasts?: number): Promise<string>;
};

const SETTINGS = ["MEDIA_S3_ENDPOINT", "MEDIA_S3_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY"] as const;

/**
 * Read URLs are signed as of the start of the current window and work for two, so
 * a page gets the same URL (which browsers can cache) all window long, and every
 * URL stops working within two windows: that's how long access lasts after someone
 * loses it (content hidden or deleted, a portal made private, a reader removed).
 */
export const SIGNED_WINDOW_SECONDS = 60 * 60;
/**
 * How long a page's URL for an uploaded video works at least: a player asks for more of it whenever it's played or
 * sought, for as long as the page is open, so a window's URL isn't enough. Losing access to the page takes effect for
 * its videos within this and a window.
 */
export const VIDEO_URL_SECONDS = 24 * 60 * 60;
/** Only the reader's browser may keep a file, and not past a window: no shared cache serves it after its URL expires. */
const PRIVATE_CACHE = `private, max-age=${SIGNED_WINDOW_SECONDS}`;

/**
 * Upload limits in megabytes, each overridable by its env var: per image (the team's, readers', an import's), per file,
 * per video, per project. An import's images come from another tool, uncompressed as often as not, and are re-encoded to
 * WebP before they're kept (packages/jobs images.ts), so they may be larger going in: as large as a file, so a copy takes
 * no more memory than an attachment does. sharp's pixel limit still applies.
 */
const MEDIA_LIMITS_MB = {
  MEDIA_MAX_IMAGE_MB_TEAM: 10,
  MEDIA_MAX_IMAGE_MB_USER: 5,
  MEDIA_MAX_IMPORT_IMAGE_MB: 25,
  MEDIA_MAX_FILE_MB_TEAM: 25,
  MEDIA_MAX_VIDEO_MB_TEAM: 200,
  MEDIA_PROJECT_QUOTA_MB: 1024,
};

/** One of the upload limits, in bytes. */
export function mediaLimit(name: keyof typeof MEDIA_LIMITS_MB): number {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : MEDIA_LIMITS_MB[name]) * 1024 * 1024;
}

/** The configured storage, or null when uploads aren't set up on this server. */
export function mediaStorage(): MediaStorage | null {
  const env = process.env;
  if (SETTINGS.some((name) => !env[name])) {
    return null;
  }
  const client = new AwsClient({
    accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY!,
    service: "s3",
    region: env.MEDIA_S3_REGION || "auto",
    // A few quick retries on 5xx (the default is 10, with backoff).
    retries: 3,
  });
  // Path-style URLs work with R2, S3 and local stand-ins alike.
  const objectUrl = (key: string) =>
    `${env.MEDIA_S3_ENDPOINT!.replace(/\/$/, "")}/${env.MEDIA_S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const send = async (key: string, init: RequestInit, okStatuses = [200]) => {
    const response = await client.fetch(objectUrl(key), init);
    if (!okStatuses.includes(response.status)) {
      throw new Error(`Storage ${init.method ?? "GET"} ${key} failed with ${response.status}`);
    }
    return response;
  };

  return {
    async presignPut(key, { contentType, size }, expiresInSeconds = 600) {
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
      const signed = await client.sign(url.href, {
        method: "PUT",
        headers: { "content-type": contentType, "content-length": String(size) },
        aws: { signQuery: true, allHeaders: true },
      });
      return signed.url;
    },
    async head(key) {
      const response = await send(key, { method: "HEAD" }, [200, 404]);
      return response.status === 404 ? null : { size: Number(response.headers.get("content-length")) };
    },
    async get(key, maxBytes) {
      const range = maxBytes ? { headers: { range: `bytes=0-${maxBytes - 1}` } } : {};
      return new Uint8Array(await (await send(key, { method: "GET", ...range }, [200, 206])).arrayBuffer());
    },
    async put(key, body, contentType) {
      await send(key, {
        method: "PUT",
        body: body as RequestInit["body"],
        headers: { "content-type": contentType, "cache-control": PRIVATE_CACHE },
      });
    },
    async putFile(key, path, contentType, signal) {
      const { size } = await stat(path);
      // The client's own retries would resend a stream the first try used up: each try here signs and sends a fresh one
      // (as many tries as the client's, on the same answers: 5xx and 429).
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const request = await client.sign(objectUrl(key), {
          method: "PUT",
          signal,
          body: Readable.toWeb(createReadStream(path)) as RequestInit["body"],
          // A stream isn't hashed for the signature: its length is signed instead.
          headers: { "content-type": contentType, "cache-control": PRIVATE_CACHE, "content-length": String(size), "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
        });
        const response = await fetch(request);
        await response.body?.cancel();
        if (response.status === 200) {
          return;
        }
        if (attempt >= client.retries || (response.status < 500 && response.status !== 429)) {
          throw new Error(`Storage PUT ${key} failed with ${response.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    },
    async copy(from, to, contentType) {
      await send(to, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${env.MEDIA_S3_BUCKET}/${from.split("/").map(encodeURIComponent).join("/")}`,
          "x-amz-metadata-directive": "REPLACE",
          "content-type": contentType,
          "cache-control": PRIVATE_CACHE,
        },
      });
    },
    async delete(key) {
      await send(key, { method: "DELETE" }, [200, 204, 404]);
    },
    async signedUrl(key, now = Date.now(), download, lasts = SIGNED_WINDOW_SECONDS) {
      const windowStart = new Date(now - (now % (SIGNED_WINDOW_SECONDS * 1000)));
      const url = new URL(objectUrl(key));
      // From the window's start: at least `lasts` from now, and the same URL all window.
      url.searchParams.set("X-Amz-Expires", String(SIGNED_WINDOW_SECONDS + lasts));
      if (download) {
        // Signed with the rest, so it can't be changed: saved, as this name, with no type to render as.
        url.searchParams.set("response-content-disposition", `attachment; filename*=UTF-8''${encodeExtValue(download)}`);
        url.searchParams.set("response-content-type", "application/octet-stream");
      }
      // 20261022T130000Z
      const datetime = windowStart.toISOString().replace(/[:-]|\.\d{3}/g, "");
      return (await client.sign(url.href, { method: "GET", aws: { signQuery: true, datetime } })).url;
    },
  };
}

/** A name as RFC 8187 has it in `filename*`: percent-encoded, `'()*` too (encodeURIComponent leaves them, and a `'` ends the value). */
const encodeExtValue = (name: string) => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
