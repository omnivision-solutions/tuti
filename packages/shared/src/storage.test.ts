import { afterEach, expect, test, vi } from "vitest";

import { mediaStorage, SIGNED_WINDOW_SECONDS } from "./storage";

const env = {
  MEDIA_S3_ENDPOINT: "https://storage.example",
  MEDIA_S3_BUCKET: "media",
  MEDIA_S3_ACCESS_KEY_ID: "key",
  MEDIA_S3_SECRET_ACCESS_KEY: "secret",
};

afterEach(() => vi.unstubAllEnvs());

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
