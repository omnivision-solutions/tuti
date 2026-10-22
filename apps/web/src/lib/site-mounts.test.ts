import { expect, test } from "vitest";

import { SITE_FIELD_MAX, siteFormAddress } from "./site-mounts";

test("the sub-folder form's site and path make one address; without a site, nothing", () => {
  expect(siteFormAddress(" https://example.com/ ", "/help")).toEqual({ url: "https://example.com/help" });
  expect(siteFormAddress("example.com", "help/center")).toEqual({ url: "example.com/help/center" });
  expect(siteFormAddress("", "help/center")).toEqual({ error: "Enter your site's address, like https://example.com" });
  expect(siteFormAddress("   ", "/help")).toMatchObject({ error: expect.any(String) });
});

test("each field is cut short before it's read, so a huge one can't hold up the server", () => {
  const result = siteFormAddress(`${"/".repeat(200_000)}a`, "/".repeat(200_000));
  expect("url" in result && result.url.length).toBeLessThanOrEqual(2 * SITE_FIELD_MAX + 1);
});
