import { expect, test } from "vitest";

import { customizeTitle } from "./app-header";

test("Customize's pages name their section in the top bar", () => {
  expect(customizeTitle("/app/acme/customize/branding")).toBe("Customize · Branding");
  expect(customizeTitle("/app/acme/customize/seo")).toBe("Customize · SEO");
  expect(customizeTitle("/app/acme/customize")).toBe("Customize");
  expect(customizeTitle("/app/acme/feedback")).toBeNull();
});
