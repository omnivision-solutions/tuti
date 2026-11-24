import { startS3Fake } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { mediaStorage, SIGNED_WINDOW_SECONDS } from "./storage";

const env = {
  MEDIA_S3_ENDPOINT: "https://storage.example",
  MEDIA_S3_BUCKET: "media",
  MEDIA_S3_ACCESS_KEY_ID: "key",
  MEDIA_S3_SECRET_ACCESS_KEY: "secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("off unless every setting is there", () => {
  for (const missing of Object.keys(env)) {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, name === missing ? "" : value);
    }
    expect(mediaStorage()).toBeNull();
  }
});

test("presigned uploads are only good for the declared type and size, for a short time", async () => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const url = new URL(await mediaStorage()!.presignPut("uploads/abc", { contentType: "image/png", size: 1234 }));
  expect(url.origin + url.pathname).toBe("https://storage.example/media/uploads/abc");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
});

test("read URLs are signed per window: the same all window long, good for two", async () => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const storage = mediaStorage()!;
  const hour = SIGNED_WINDOW_SECONDS * 1000;
  const start = Date.UTC(2026, 9, 22, 13);
  const url = new URL(await storage.signedUrl("m/abc/480.webp", start + 1000));
  expect(url.origin + url.pathname).toBe("https://storage.example/media/m/abc/480.webp");
  expect(url.searchParams.get("X-Amz-Date")).toBe("20261022T130000Z");
  expect(url.searchParams.get("X-Amz-Expires")).toBe(String(2 * SIGNED_WINDOW_SECONDS));
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  expect(await storage.signedUrl("m/abc/480.webp", start + hour - 1)).toBe(url.href);
  expect(await storage.signedUrl("m/abc/480.webp", start + hour)).not.toBe(url.href);
  expect(await storage.signedUrl("m/abc/960.webp", start + 1000)).not.toBe(url.href);
});

test("a download URL saves the file under its name, as plain bytes, and is signed with it", async () => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const storage = mediaStorage()!;
  const start = Date.UTC(2026, 9, 22, 13);
  const shown = await storage.signedUrl("attachments/p/a", start);
  const download = new URL(await storage.signedUrl("attachments/p/a", start, "Invoice Oct (2).pdf"));
  expect(download.searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Invoice%20Oct%20%282%29.pdf");
  // A ' would end the name early (browsers drop it then).
  const apostrophe = new URL(await storage.signedUrl("attachments/p/a", start, "Customer's guide.pdf"));
  expect(apostrophe.searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Customer%27s%20guide.pdf");
  expect(download.searchParams.get("response-content-type")).toBe("application/octet-stream");
  expect(download.searchParams.get("X-Amz-Signature")).not.toBe(new URL(shown).searchParams.get("X-Amz-Signature"));
});

test("a file put says its length, even through Next's fetch, which sends a request's body on as a stream", async () => {
  const s3 = await startS3Fake();
  try {
    for (const [name, value] of Object.entries(s3.env)) {
      vi.stubEnv(name, value);
    }
    // Inside a request, Next's patched fetch rebuilds a Request from its fields (next/dist/server/lib/patch-fetch.js),
    // its body a stream of unknown length: without a length of its own, the PUT goes out chunked, which S3 and R2 refuse.
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      input instanceof Request ? fetch(new Request(input.url, { method: input.method, headers: input.headers, body: input.body, duplex: "half" } as RequestInit), init) : fetch(input, init),
    );
    await mediaStorage()!.put("images/a.png", Buffer.from("a picture"), "image/png");
    expect(s3.objects.get("images/a.png")).toEqual({ body: Buffer.from("a picture"), contentType: "image/png" });
  } finally {
    await s3.close();
  }
});
