import { afterEach, expect, test, vi } from "vitest";

import { signForever, verifyForever } from "./signed";

afterEach(() => vi.unstubAllEnvs());

test("lasting links survive rotating the auth secret when they have a secret of their own", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "auth-one");
  vi.stubEnv("MEDIA_LINK_SECRET", "links-one");
  const signature = signForever("media", "m/x/email.jpg");
  vi.stubEnv("BETTER_AUTH_SECRET", "auth-two");
  expect(verifyForever("media", "m/x/email.jpg", signature)).toBe(true);
  vi.stubEnv("MEDIA_LINK_SECRET", "links-two");
  expect(verifyForever("media", "m/x/email.jpg", signature)).toBe(false);
});

test("without one, they're keyed with the auth secret", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "auth-one");
  vi.stubEnv("MEDIA_LINK_SECRET", "");
  const signature = signForever("media", "m/x/email.jpg");
  expect(verifyForever("media", "m/x/email.jpg", signature)).toBe(true);
  vi.stubEnv("BETTER_AUTH_SECRET", "auth-two");
  expect(verifyForever("media", "m/x/email.jpg", signature)).toBe(false);
});
