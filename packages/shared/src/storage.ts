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
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** A URL that reads the file for a while (see SIGNED_WINDOW_SECONDS). */
  signedUrl(key: string, now?: number): Promise<string>;
};

const SETTINGS = ["MEDIA_S3_ENDPOINT", "MEDIA_S3_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY"] as const;

/**
 * Read URLs are signed as of the start of the current window and work for two, so
 * a page gets the same URL (which browsers can cache) all window long, and every
 * URL stops working within two windows: that's how long access lasts after someone
 * loses it (content hidden or deleted, a portal made private, a reader removed).
 */
export const SIGNED_WINDOW_SECONDS = 60 * 60;
/** Only the reader's browser may keep a file, and not past a window: no shared cache serves it after its URL expires. */
const PRIVATE_CACHE = `private, max-age=${SIGNED_WINDOW_SECONDS}`;

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
    async get(key) {
      return new Uint8Array(await (await send(key, { method: "GET" })).arrayBuffer());
    },
    async put(key, body, contentType) {
      await send(key, {
        method: "PUT",
        body: body as RequestInit["body"],
        headers: { "content-type": contentType, "cache-control": PRIVATE_CACHE },
      });
    },
    async delete(key) {
      await send(key, { method: "DELETE" }, [200, 204, 404]);
    },
    async signedUrl(key, now = Date.now()) {
      const windowStart = new Date(now - (now % (SIGNED_WINDOW_SECONDS * 1000)));
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(2 * SIGNED_WINDOW_SECONDS));
      // 20261022T130000Z
      const datetime = windowStart.toISOString().replace(/[:-]|\.\d{3}/g, "");
      return (await client.sign(url.href, { method: "GET", aws: { signQuery: true, datetime } })).url;
    },
  };
}
