import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { lastingMediaUrl, pictureUrl, savedPicture } from "./media-links";

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  vi.stubEnv("BETTER_AUTH_SECRET", "a-test-secret-at-least-32-characters-long");
});
afterEach(() => vi.unstubAllEnvs());

test("an uploaded picture is saved without host or path, and read as a link made then, with today's APP_URL", () => {
  const saved = savedPicture("m/media1/96.webp");
  expect(saved).toMatch(/^m\/media1\/96\.webp\?s=[\w-]+$/);
  expect(pictureUrl(saved)).toBe(`https://tuti.example/api/media/${saved.slice(2)}`);
  expect(pictureUrl(saved)).toBe(lastingMediaUrl("m/media1/96.webp"));
  vi.stubEnv("APP_URL", "https://moved.example");
  expect(pictureUrl(saved)).toBe(`https://moved.example/api/media/${saved.slice(2)}`);
});

test("a picture from elsewhere, or anything else, stays as it is", () => {
  expect(pictureUrl("https://example.com/face.png")).toBe("https://example.com/face.png");
  expect(pictureUrl("m/media1/96.webp")).toBe("m/media1/96.webp");
  expect(pictureUrl(null)).toBeNull();
});

test("without APP_URL an upload's picture is none, never an error for whatever read the user", () => {
  const saved = savedPicture("m/media1/96.webp");
  vi.stubEnv("APP_URL", "");
  expect(pictureUrl(saved)).toBeNull();
  expect(() => lastingMediaUrl("m/media1/96.webp")).toThrow("Lasting media links need APP_URL");
});
