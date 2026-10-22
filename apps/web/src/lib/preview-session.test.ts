import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PREVIEW_TTL_SECONDS, previewToken, previewUser } from "./preview-session";
import { widgetToken } from "./widget-session";

beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

test("a preview token is for one person in one project, for an hour", () => {
  const now = Date.now();
  const token = previewToken("project-1", "user-1", now);
  expect(previewUser("project-1", token, now)).toBe("user-1");
  expect(previewUser("project-2", token, now)).toBeNull();
  expect(previewUser("project-1", token, now + PREVIEW_TTL_SECONDS * 1000 + 1)).toBeNull();
  // Not forged, and not another purpose's token.
  expect(previewUser("project-1", token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), now)).toBeNull();
  expect(previewUser("project-1", widgetToken("project-1", "user-1", now), now)).toBeNull();
  expect(previewUser("project-1", "", now)).toBeNull();
});
