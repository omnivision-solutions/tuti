import { expect, test, vi } from "vitest";

import { widgetToken, widgetUser } from "./widget-session";

test("a widget token is for one person in one project, until it expires, and can't be forged", () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
  const now = Date.UTC(2026, 9, 19, 12);
  const token = widgetToken("project-1", "user-1", now);
  expect(widgetUser("project-1", token, now)).toBe("user-1");
  expect(widgetUser("project-2", token, now)).toBeNull(); // another project
  expect(widgetUser("project-1", token, now + 13 * 60 * 60 * 1000)).toBeNull(); // after 12 hours
  expect(widgetUser("project-1", token.replace("user-1", "user-2"), now)).toBeNull(); // tampered
  expect(widgetUser("project-1", "nonsense", now)).toBeNull();
  vi.unstubAllEnvs();
});
