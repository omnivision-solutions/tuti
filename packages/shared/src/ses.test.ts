import { afterEach, expect, test, vi } from "vitest";

import { assertSesSettings, ses } from "./ses";

const ALL = {
  SES_REGION: "us-east-1",
  SES_ACCESS_KEY_ID: "key",
  SES_SECRET_ACCESS_KEY: "secret",
  SES_CONFIGURATION_SET: "tuti-support",
  SES_EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:tuti-ses-events",
};
afterEach(() => vi.unstubAllEnvs());

test("SES is on with all five settings, off with none, and some but not all stops the server naming the missing ones", () => {
  for (const name of Object.keys(ALL)) {
    vi.stubEnv(name, "");
  }
  expect(ses()).toBeNull();
  expect(() => assertSesSettings()).not.toThrow();

  for (const [name, value] of Object.entries(ALL)) {
    vi.stubEnv(name, value);
  }
  expect(() => assertSesSettings()).not.toThrow();
  expect(ses()).toMatchObject({
    configurationSet: "tuti-support",
    configurationSetArn: "arn:aws:ses:us-east-1:000000000000:configuration-set/tuti-support",
  });
  expect(ses()!.identityArn("tuti.email")).toBe("arn:aws:ses:us-east-1:000000000000:identity/tuti.email");

  vi.stubEnv("SES_SECRET_ACCESS_KEY", "");
  vi.stubEnv("SES_EVENTS_TOPIC_ARN", "");
  expect(() => assertSesSettings()).toThrow("missing SES_SECRET_ACCESS_KEY, SES_EVENTS_TOPIC_ARN");
  expect(ses()).toBeNull();
});

test("a configuration set too long to name tenants after stops the server", () => {
  for (const [name, value] of Object.entries(ALL)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("SES_CONFIGURATION_SET", "c".repeat(38));
  expect(() => assertSesSettings()).not.toThrow();
  vi.stubEnv("SES_CONFIGURATION_SET", "c".repeat(39));
  expect(() => assertSesSettings()).toThrow("38 characters at most");
});
