import { afterEach, expect, test, vi } from "vitest";

import { asksToVerifyEmail } from "./verify-email";

afterEach(() => vi.unstubAllEnvs());

test("the strip asks to verify an email only while it isn't verified and the server sends email", () => {
  vi.stubEnv("SMTP_HOST", "smtp.example.com");
  expect(asksToVerifyEmail({ emailVerified: false })).toBe(true);
  expect(asksToVerifyEmail({ emailVerified: true })).toBe(false);
  // Without SMTP the link only goes to the log: nothing the person could do, so no strip.
  vi.stubEnv("SMTP_HOST", "");
  expect(asksToVerifyEmail({ emailVerified: false })).toBe(false);
});
