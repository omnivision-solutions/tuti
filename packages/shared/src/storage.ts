import { AwsClient } from "aws4fetch";

/**
 * Media storage: any S3-compatible bucket (R2 on tuti.so), set up with `MEDIA_*`
 * env vars. Browsers upload straight to it with presigned URLs; pages load files
 * from MEDIA_PUBLIC_URL, a separate host that never gets Tuti's session cookies.
 */
export type MediaStorage = {
  /** A URL the browser can PUT exactly this file to (type and size are part of the signature). */
  presignPut(key: string, file: { contentType: string; size: number }, expiresInSeconds?: number): Promise<string>;
  /** The object's size, or null if it isn't there. */
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
};

const SETTINGS = ["MEDIA_S3_ENDPOINT", "MEDIA_S3_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY", "MEDIA_PUBLIC_URL"] as const;

/** Files never change once written (new uploads get new keys), so they can be cached for good. */
const IMMUTABLE = "public, max-age=31536000, immutable";

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
        headers: { "content-type": contentType, "cache-control": IMMUTABLE },
      });
    },
    async delete(key) {
      await send(key, { method: "DELETE" }, [200, 204, 404]);
    },
    publicUrl(key) {
      return `${env.MEDIA_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
    },
  };
}

/** Where pages load media from, or null when uploads aren't set up. */
export function mediaPublicUrl(): string | null {
  return mediaStorage() ? process.env.MEDIA_PUBLIC_URL!.replace(/\/$/, "") : null;
}
