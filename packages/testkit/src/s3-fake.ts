import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type S3Fake = {
  /** Endpoint to use as MEDIA_S3_ENDPOINT (path-style: <url>/<bucket>/<key>). */
  url: string;
  bucket: string;
  /** Env vars that point the app at this fake (public URL included). */
  env: Record<string, string>;
  /** Stored objects by key. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Keys whose DELETE answers 500, to test failures. */
  failDeletes: Set<string>;
  close(): Promise<void>;
};

/**
 * A local stand-in for S3-compatible storage: PUT, GET, HEAD and DELETE on
 * path-style URLs, presigned or not (signatures aren't checked), with CORS so
 * browsers can upload to it. Also serves objects publicly at <url>/<bucket>/<key>.
 */
export async function startS3Fake(bucket = "tuti-media-test"): Promise<S3Fake> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const failDeletes = new Set<string>();

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, HEAD, DELETE");
    // Whatever the browser asks for (journeys add headers of their own, like x-forwarded-for).
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://fake").pathname);
    const prefix = `/${bucket}/`;
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const key = path.slice(prefix.length);

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const object = objects.get(key);
      switch (req.method) {
        case "PUT":
          objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers["content-type"] ?? "" });
          res.writeHead(200).end();
          return;
        case "GET":
        case "HEAD":
          if (!object) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "Content-Type": object.contentType, "Content-Length": object.body.length });
          res.end(req.method === "GET" ? object.body : undefined);
          return;
        case "DELETE":
          if (failDeletes.has(key)) {
            res.writeHead(500).end();
            return;
          }
          objects.delete(key);
          res.writeHead(204).end();
          return;
        default:
          res.writeHead(405).end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    bucket,
    objects,
    failDeletes,
    env: {
      MEDIA_S3_ENDPOINT: url,
      MEDIA_S3_BUCKET: bucket,
      MEDIA_S3_ACCESS_KEY_ID: "test-access-key",
      MEDIA_S3_SECRET_ACCESS_KEY: "test-secret-key",
      MEDIA_PUBLIC_URL: `${url}/${bucket}`,
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
