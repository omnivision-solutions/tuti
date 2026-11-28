import { expect, test } from "vitest";

import { siteFormAddress } from "./site-mounts";

test("the sub-folder form's site and path make one address; without a site, nothing", () => {
  expect(siteFormAddress(" https://example.com/ ", "/help")).toEqual({ url: "https://example.com/help" });
  expect(siteFormAddress("example.com", "help/center")).toEqual({ url: "example.com/help/center" });
  expect(siteFormAddress("", "help/center")).toEqual({ error: "Enter your site's address, like https://example.com" });
  expect(siteFormAddress("   ", "/help")).toEqual({ error: "Enter your site's address, like https://example.com" });
});

test("each field is cut short before it's read, so a huge one can't hold up the server", () => {
  // Read whole, the site's "a" would be kept, after a slow trim of the slashes before it.
  expect(siteFormAddress(`${"/".repeat(200_000)}a`, "/".repeat(200_000))).toEqual({ url: "/" });
});
