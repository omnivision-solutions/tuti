import { afterEach, expect, test, vi } from "vitest";

import { mediaStorage } from "./storage";

const env = {
  MEDIA_S3_ENDPOINT: "https://storage.example",
  MEDIA_S3_BUCKET: "media",
  MEDIA_S3_ACCESS_KEY_ID: "key",
  MEDIA_S3_SECRET_ACCESS_KEY: "secret",
  MEDIA_PUBLIC_URL: "https://media.example/",
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
  expect(mediaStorage()!.publicUrl("m/abc/480.webp")).toBe("https://media.example/m/abc/480.webp");
});
