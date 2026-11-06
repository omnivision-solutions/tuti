import { afterEach, expect, test, vi } from "vitest";

import { openValue, sealValue, signForever, signValue, verifyForever } from "./signed";

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

test("nothing is signed without a secret", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  expect(() => signValue("test", ["a"], 60)).toThrow("BETTER_AUTH_SECRET");
});

test("a sealed value opens only with the same secret and purpose, and not once changed; it never shows the text", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "unit-secret-at-least-32-characters-long");
  const sealed = sealValue("import-key", "sk_live_example");
  expect(sealed).not.toContain("sk_live_example");
  expect(sealValue("import-key", "sk_live_example")).not.toBe(sealed);
  expect(openValue("import-key", sealed)).toBe("sk_live_example");
  expect(() => openValue("other", sealed)).toThrow();
  expect(() => openValue("import-key", `${sealed.slice(0, -2)}AA`)).toThrow();
  vi.stubEnv("BETTER_AUTH_SECRET", "another-secret-at-least-32-characters");
  expect(() => openValue("import-key", sealed)).toThrow();
});
