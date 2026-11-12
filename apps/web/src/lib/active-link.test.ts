import { expect, test } from "vitest";

import { activeHref, activeView } from "./active-link";

test("a page under a section keeps that section's link, not the parent's", () => {
  const hrefs = ["/app/acme/settings", "/app/acme/settings/integrations", "/app/acme/settings/sso"];
  expect(activeHref("/app/acme/settings", hrefs)).toBe("/app/acme/settings");
  expect(activeHref("/app/acme/settings/integrations/github", hrefs)).toBe("/app/acme/settings/integrations");
  expect(activeHref("/app/acme/settings/integrationsx", hrefs)).toBe("/app/acme/settings");
  expect(activeHref("/app/other", hrefs)).toBeUndefined();
});

test("a view in the query string is open on its own URL, the plain one otherwise", () => {
  const hrefs = ["/app/acme/feedback", "/app/acme/feedback?view=mine"];
  expect(activeView("/app/acme/feedback", "", hrefs)).toBe("/app/acme/feedback");
  expect(activeView("/app/acme/feedback", "view=mine", hrefs)).toBe("/app/acme/feedback?view=mine");
  expect(activeView("/app/acme/feedback", "page=2", hrefs)).toBe("/app/acme/feedback");
  expect(activeView("/app/acme/feedback/12", "", hrefs)).toBe("/app/acme/feedback");
});
