import { expect, test } from "vitest";

import { activeHref } from "./active-link";

test("a page under a section keeps that section's link, not the parent's", () => {
  const hrefs = ["/app/acme/settings", "/app/acme/settings/integrations", "/app/acme/settings/sso"];
  expect(activeHref("/app/acme/settings", hrefs)).toBe("/app/acme/settings");
  expect(activeHref("/app/acme/settings/integrations/github", hrefs)).toBe("/app/acme/settings/integrations");
  expect(activeHref("/app/acme/settings/integrationsx", hrefs)).toBe("/app/acme/settings");
  expect(activeHref("/app/other", hrefs)).toBeUndefined();
});
